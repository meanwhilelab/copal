-- Custom SQL migration: rename items.note → items.description (the human's
-- framing, more UI-prominent) and add the Librarian-compiled items.context.
-- RENAME COLUMN preserves data and is picked up automatically by the
-- generated items.search tsvector expression (Postgres tracks it by attnum,
-- not by name) and by any FK/index on the table — nothing else to touch.
ALTER TABLE "items" RENAME COLUMN "note" TO "description";--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "context" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "context_compiled_at" timestamp with time zone;
