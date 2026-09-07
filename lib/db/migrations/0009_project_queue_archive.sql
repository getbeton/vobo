ALTER TABLE "projects" ADD COLUMN "archived_at" timestamp;--> statement-breakpoint
ALTER TABLE "queues" ADD COLUMN "archived_at" timestamp;
