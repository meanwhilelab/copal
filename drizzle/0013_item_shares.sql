CREATE TABLE "item_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_by_client_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "item_shares_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "item_shares" ADD CONSTRAINT "item_shares_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_shares" ADD CONSTRAINT "item_shares_created_by_client_id_api_clients_id_fk" FOREIGN KEY ("created_by_client_id") REFERENCES "public"."api_clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "item_shares_active_uq" ON "item_shares" USING btree ("item_id") WHERE "item_shares"."revoked_at" IS NULL;