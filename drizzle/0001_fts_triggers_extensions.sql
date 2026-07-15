-- Custom SQL migration: extensions, FTS, triggers, integrity ------------------

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- updated_at maintenance
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspaces','api_clients','boards','items','ideas','sessions','contents','jobs']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;

-- Full-text search. Indexed text is capped (left(...)) to stay under the ~1MB
-- tsvector limit; full bodies remain stored. sessions/contents use a per-row
-- regconfig column (mixed EN/IT corpus); ideas/items use 'simple'.
ALTER TABLE sessions ADD COLUMN search tsvector GENERATED ALWAYS AS (
  to_tsvector(language, left(coalesce(transcript, '') || ' ' || coalesce(summary, ''), 500000))
) STORED;

ALTER TABLE contents ADD COLUMN search tsvector GENERATED ALWAYS AS (
  to_tsvector(language, left(coalesce(title, '') || ' ' || coalesce(body, ''), 500000))
) STORED;

ALTER TABLE ideas ADD COLUMN search tsvector GENERATED ALWAYS AS (
  to_tsvector('simple', coalesce(title, '') || ' ' || left(coalesce(description, ''), 500000))
) STORED;

ALTER TABLE items ADD COLUMN search tsvector GENERATED ALWAYS AS (
  to_tsvector('simple', coalesce(name, '') || ' ' || left(coalesce(note, ''), 500000))
) STORED;

CREATE INDEX sessions_search_idx ON sessions USING gin (search);
CREATE INDEX contents_search_idx ON contents USING gin (search);
CREATE INDEX ideas_search_idx ON ideas USING gin (search);
CREATE INDEX items_search_idx ON items USING gin (search);

-- Trigram indexes for substring matching across languages
CREATE INDEX contents_title_trgm_idx ON contents USING gin (title gin_trgm_ops);
CREATE INDEX ideas_title_trgm_idx ON ideas USING gin (title gin_trgm_ops);
CREATE INDEX items_name_trgm_idx ON items USING gin (name gin_trgm_ops);
CREATE INDEX boards_name_trgm_idx ON boards USING gin (name gin_trgm_ops);

-- Foreground/derived-condition support
CREATE INDEX ideas_last_touched_idx ON ideas (last_touched_at DESC) WHERE sunk_at IS NULL;
CREATE INDEX items_board_status_idx ON items (board_id, status) WHERE sunk_at IS NULL;
CREATE INDEX jobs_pending_run_after_idx ON jobs (run_after) WHERE status = 'pending';
CREATE INDEX links_from_idx ON links (from_type, from_id);
CREATE INDEX links_to_idx ON links (to_type, to_id);

-- Polymorphic link integrity
CREATE OR REPLACE FUNCTION assert_entity_exists(etype text, eid uuid) RETURNS void AS $$
DECLARE found boolean;
BEGIN
  CASE etype
    WHEN 'board'   THEN SELECT EXISTS(SELECT 1 FROM boards   WHERE id = eid) INTO found;
    WHEN 'item'    THEN SELECT EXISTS(SELECT 1 FROM items    WHERE id = eid) INTO found;
    WHEN 'idea'    THEN SELECT EXISTS(SELECT 1 FROM ideas    WHERE id = eid) INTO found;
    WHEN 'session' THEN SELECT EXISTS(SELECT 1 FROM sessions WHERE id = eid) INTO found;
    WHEN 'content' THEN SELECT EXISTS(SELECT 1 FROM contents WHERE id = eid) INTO found;
    ELSE RAISE EXCEPTION 'unknown link entity type: %', etype;
  END CASE;
  IF NOT found THEN
    RAISE EXCEPTION 'link target does not exist: % %', etype, eid;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_link() RETURNS trigger AS $$
BEGIN
  PERFORM assert_entity_exists(NEW.from_type, NEW.from_id);
  PERFORM assert_entity_exists(NEW.to_type, NEW.to_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER links_validate BEFORE INSERT OR UPDATE ON links
  FOR EACH ROW EXECUTE FUNCTION validate_link();

-- Idea trail aggregates (touch links maintain the warm/dormant inputs)
CREATE OR REPLACE FUNCTION bump_idea_trail() RETURNS trigger AS $$
BEGIN
  IF NEW.link_type = 'touches' AND NEW.to_type = 'idea' THEN
    UPDATE ideas
      SET last_touched_at = now(), touch_count = touch_count + 1
      WHERE id = NEW.to_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER links_bump_idea_trail AFTER INSERT ON links
  FOR EACH ROW EXECUTE FUNCTION bump_idea_trail();
