CREATE TABLE "policy_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" integer NOT NULL,
	"project_id" uuid,
	"parent_template_id" uuid,
	"name" varchar(100) NOT NULL,
	"slug" varchar(64) NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "policy_templates" ADD CONSTRAINT "policy_templates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_templates" ADD CONSTRAINT "policy_templates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_templates" ADD CONSTRAINT "policy_templates_parent_id_policy_templates_id_fk" FOREIGN KEY ("parent_template_id") REFERENCES "public"."policy_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "policy_templates_ws_slug_uq" ON "policy_templates" USING btree ("workspace_id","slug") WHERE "policy_templates"."project_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "policy_templates_project_slug_uq" ON "policy_templates" USING btree ("project_id","slug") WHERE "policy_templates"."project_id" is not null;--> statement-breakpoint
CREATE INDEX "policy_templates_workspace_idx" ON "policy_templates" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "policy_templates_project_idx" ON "policy_templates" USING btree ("project_id");--> statement-breakpoint
INSERT INTO "policy_templates" ("workspace_id", "name", "slug", "config")
SELECT "id", 'Default', 'default', "policy_defaults" FROM "workspaces";--> statement-breakpoint
INSERT INTO "policy_templates" ("workspace_id", "project_id", "parent_template_id", "name", "slug", "config")
SELECT p."workspace_id", p."id", wt."id", 'Default', 'default', '{}'::jsonb
FROM "projects" p
INNER JOIN "policy_templates" wt
	ON wt."workspace_id" = p."workspace_id" AND wt."project_id" IS NULL AND wt."slug" = 'default';--> statement-breakpoint
ALTER TABLE "queues" ADD COLUMN "template_id" uuid;--> statement-breakpoint
UPDATE "queues" q
SET "template_id" = pt."id"
FROM "policy_templates" pt
WHERE pt."project_id" = q."project_id" AND pt."slug" = 'default';--> statement-breakpoint
ALTER TABLE "queues" ALTER COLUMN "template_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "queues" ADD CONSTRAINT "queues_template_id_policy_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."policy_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD COLUMN "template_id" uuid;--> statement-breakpoint
UPDATE "policy_versions" pv
SET "template_id" = q."template_id"
FROM "queues" q
WHERE q."id" = pv."queue_id";--> statement-breakpoint
ALTER TABLE "policy_versions" ALTER COLUMN "template_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_template_id_policy_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."policy_templates"("id") ON DELETE no action ON UPDATE no action;
