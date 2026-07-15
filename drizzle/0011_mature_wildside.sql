CREATE TABLE "worker_ticks" (
	"name" text PRIMARY KEY NOT NULL,
	"last_success_at" timestamp with time zone DEFAULT now() NOT NULL
);
