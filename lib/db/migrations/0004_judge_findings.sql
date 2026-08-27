CREATE TYPE "public"."workspace_plan" AS ENUM('community', 'cloud_free', 'cloud_paid', 'enterprise', 'self_host');--> statement-breakpoint
CREATE TYPE "public"."finding_severity" AS ENUM('critical', 'minor');--> statement-breakpoint
CREATE TYPE "public"."finding_triage" AS ENUM('untriaged', 'confirmed', 'dismissed', 'suppressed');--> statement-breakpoint
CREATE TYPE "public"."judge_run_state" AS ENUM('pending', 'running', 'completed', 'failed', 'not_sampled');--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "plan" "workspace_plan" DEFAULT 'cloud_paid' NOT NULL;--> statement-breakpoint
ALTER TABLE "review_requests" ADD COLUMN "judge_overall_score" real;--> statement-breakpoint
ALTER TABLE "review_requests" ADD COLUMN "judge_blind" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE "finding_producers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"slug" varchar(64) NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"muted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "producer_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"producer_id" uuid NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" varchar(12) NOT NULL,
	"rate_limit_per_minute" integer DEFAULT 600 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp,
	"revoked_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "finding_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"producer_id" uuid NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"finding_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machine_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"producer_id" uuid NOT NULL,
	"judge_run_id" uuid,
	"criterion_key" varchar(64) NOT NULL,
	"severity" "finding_severity" DEFAULT 'minor' NOT NULL,
	"quote" text NOT NULL,
	"prefix" text DEFAULT '' NOT NULL,
	"suffix" text DEFAULT '' NOT NULL,
	"start_pos" integer NOT NULL,
	"end_pos" integer NOT NULL,
	"structural_container" varchar(255),
	"structural_block_id" varchar(255),
	"structural_ordinal" integer,
	"evidence" text NOT NULL,
	"note" text NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"triage" "finding_triage" DEFAULT 'untriaged' NOT NULL,
	"dismissal_reason" text,
	"dismissed_by" text,
	"dismissed_at" timestamp,
	"confirmed_annotation_id" uuid,
	"confirmed_by" text,
	"confirmed_at" timestamp,
	"purged_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dismissal_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"reason" text NOT NULL,
	"dismissed_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "judge_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"policy_version_id" uuid NOT NULL,
	"state" "judge_run_state" DEFAULT 'pending' NOT NULL,
	"overall_score" real,
	"error_class" varchar(64),
	"error_message" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "judge_records" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"request_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"run_id" uuid,
	"payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "finding_producers" ADD CONSTRAINT "finding_producers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "producer_keys" ADD CONSTRAINT "producer_keys_producer_id_finding_producers_id_fk" FOREIGN KEY ("producer_id") REFERENCES "public"."finding_producers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_batches" ADD CONSTRAINT "finding_batches_version_id_artifact_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_batches" ADD CONSTRAINT "finding_batches_producer_id_finding_producers_id_fk" FOREIGN KEY ("producer_id") REFERENCES "public"."finding_producers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_findings" ADD CONSTRAINT "machine_findings_request_id_review_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."review_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_findings" ADD CONSTRAINT "machine_findings_version_id_artifact_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_findings" ADD CONSTRAINT "machine_findings_producer_id_finding_producers_id_fk" FOREIGN KEY ("producer_id") REFERENCES "public"."finding_producers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_findings" ADD CONSTRAINT "machine_findings_dismissed_by_user_id_fk" FOREIGN KEY ("dismissed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_findings" ADD CONSTRAINT "machine_findings_confirmed_annotation_id_annotations_id_fk" FOREIGN KEY ("confirmed_annotation_id") REFERENCES "public"."annotations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_findings" ADD CONSTRAINT "machine_findings_confirmed_by_user_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dismissal_memory" ADD CONSTRAINT "dismissal_memory_request_id_review_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."review_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dismissal_memory" ADD CONSTRAINT "dismissal_memory_dismissed_by_user_id_fk" FOREIGN KEY ("dismissed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judge_runs" ADD CONSTRAINT "judge_runs_request_id_review_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."review_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judge_runs" ADD CONSTRAINT "judge_runs_version_id_artifact_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judge_runs" ADD CONSTRAINT "judge_runs_policy_version_id_policy_versions_id_fk" FOREIGN KEY ("policy_version_id") REFERENCES "public"."policy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judge_records" ADD CONSTRAINT "judge_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judge_records" ADD CONSTRAINT "judge_records_request_id_review_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."review_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judge_records" ADD CONSTRAINT "judge_records_version_id_artifact_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judge_records" ADD CONSTRAINT "judge_records_run_id_judge_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."judge_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "finding_producers_project_slug_uq" ON "finding_producers" USING btree ("project_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "producer_keys_key_hash_uq" ON "producer_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "producer_keys_producer_idx" ON "producer_keys" USING btree ("producer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "finding_batches_version_producer_key_uq" ON "finding_batches" USING btree ("version_id","producer_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "machine_findings_request_idx" ON "machine_findings" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "machine_findings_version_idx" ON "machine_findings" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "machine_findings_fingerprint_idx" ON "machine_findings" USING btree ("request_id","fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "dismissal_memory_request_fp_uq" ON "dismissal_memory" USING btree ("request_id","fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "judge_runs_version_uq" ON "judge_runs" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "judge_records_workspace_idx" ON "judge_records" USING btree ("workspace_id","id");
