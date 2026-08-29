CREATE TYPE "public"."manual_edit_status" AS ENUM('pending', 'applied', 'rejected');
--> statement-breakpoint
CREATE TABLE "manual_edits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"base_version_id" uuid NOT NULL,
	"start_pos" integer NOT NULL,
	"end_pos" integer NOT NULL,
	"original_quote" text NOT NULL,
	"replacement" text NOT NULL,
	"status" "manual_edit_status" DEFAULT 'pending' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"decided_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "manual_edits" ADD CONSTRAINT "manual_edits_request_id_review_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."review_requests"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "manual_edits" ADD CONSTRAINT "manual_edits_base_version_id_artifact_versions_id_fk" FOREIGN KEY ("base_version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "manual_edits" ADD CONSTRAINT "manual_edits_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "manual_edits_request_status_idx" ON "manual_edits" USING btree ("request_id","status");
