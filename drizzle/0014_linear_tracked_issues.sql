CREATE UNIQUE INDEX "contents_linear_ref_uq" ON "contents" USING btree ("workspace_id","source_url") WHERE source_type = 'linear';--> statement-breakpoint

-- Backfill: every item whose single `link` points at a Linear issue becomes an
-- item that TRACKS that issue. `link` itself is left alone — it stays the
-- display chip. Titles/bodies stay empty; the first item_context compile after
-- this migration fills them in from the live issue.
--
-- substring(x from 'pattern') returns the first parenthesised group, which is
-- why the org slug and the identifier are extracted with separate calls.
INSERT INTO contents (workspace_id, title, source_type, source_url)
SELECT b.workspace_id,
       substring(i.link from '(?i)linear[.]app/[^/]+/issue/([A-Za-z][A-Za-z0-9]*-[0-9]+)'),
       'linear',
       'https://linear.app/'
         || substring(i.link from '(?i)linear[.]app/([^/]+)/issue/')
         || '/issue/'
         || substring(i.link from '(?i)linear[.]app/[^/]+/issue/([A-Za-z][A-Za-z0-9]*-[0-9]+)')
  FROM items i
  JOIN boards b ON b.id = i.board_id
 WHERE i.link ~* 'linear[.]app/[^/]+/issue/[A-Za-z][A-Za-z0-9]*-[0-9]+'
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO links (from_type, from_id, to_type, to_id, link_type)
SELECT 'item', i.id, 'content', c.id, 'tracks'
  FROM items i
  JOIN boards b ON b.id = i.board_id
  JOIN contents c
    ON c.workspace_id = b.workspace_id
   AND c.source_type = 'linear'
   AND c.source_url = 'https://linear.app/'
         || substring(i.link from '(?i)linear[.]app/([^/]+)/issue/')
         || '/issue/'
         || substring(i.link from '(?i)linear[.]app/[^/]+/issue/([A-Za-z][A-Za-z0-9]*-[0-9]+)')
 WHERE i.link ~* 'linear[.]app/[^/]+/issue/[A-Za-z][A-Za-z0-9]*-[0-9]+'
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO jobs (kind, subject_id, payload)
SELECT 'item_context', i.id, jsonb_build_object('item_id', i.id)
  FROM items i
 WHERE i.link ~* 'linear[.]app/[^/]+/issue/[A-Za-z][A-Za-z0-9]*-[0-9]+'
ON CONFLICT DO NOTHING;
