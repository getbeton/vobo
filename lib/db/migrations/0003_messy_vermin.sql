ALTER TABLE "review_requests" ADD COLUMN "budget_exhausted_at" timestamp;--> statement-breakpoint
ALTER TABLE "review_requests" ADD COLUMN "budget_exhausted_by" text;--> statement-breakpoint
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_budget_exhausted_by_user_id_fk" FOREIGN KEY ("budget_exhausted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;