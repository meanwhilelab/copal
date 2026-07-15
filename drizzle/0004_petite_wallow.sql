ALTER TABLE "idempotency_keys" ALTER COLUMN "response" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "contents_created_at_idx" ON "contents" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ideas_created_at_idx" ON "ideas" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sessions_created_at_idx" ON "sessions" USING btree ("created_at" DESC NULLS LAST);
