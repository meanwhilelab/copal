ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_client_id_api_clients_id_fk";
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_client_id_api_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."api_clients"("id") ON DELETE set null ON UPDATE no action;