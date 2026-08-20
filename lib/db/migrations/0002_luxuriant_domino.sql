ALTER TABLE "review_requests" ADD COLUMN "archived_at" timestamp;--> statement-breakpoint
ALTER TABLE "review_requests" ADD COLUMN "archived_by" text;--> statement-breakpoint
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_archived_by_user_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;