-- Adds `projects`, and scopes `videos`/`templates`/`renders` to one.
--
-- Hand-edited from drizzle-kit's generated output: a plain
-- `ADD COLUMN ... NOT NULL` on `videos`/`templates`/`renders` fails outright
-- against a database that already has rows in those tables (this one does —
-- StepCut has been live since Phase 2). So each column is added nullable,
-- backfilled, then locked down, with one "General" project minted per
-- existing org in between to backfill into. A fresh org created after this
-- migration never hits this path — it starts with zero projects, and
-- `apps/stepcut`'s Home screen is where its first one gets created.

CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_projects_id_org" UNIQUE("id","org_id")
);
--> statement-breakpoint
CREATE INDEX "idx_projects_org_id" ON "projects" USING btree ("org_id");
--> statement-breakpoint
-- One project per org that already has at least one video/template/render to
-- own — an org with none of those yet gets no project here, and starts fresh
-- from the Home screen's "create a project" flow instead.
INSERT INTO "projects" ("id", "org_id", "name")
SELECT gen_random_uuid()::text, "org_id", 'General'
FROM (
	SELECT "org_id" FROM "videos"
	UNION
	SELECT "org_id" FROM "templates"
	UNION
	SELECT "org_id" FROM "renders"
) "orgs_with_data";
--> statement-breakpoint
ALTER TABLE "videos" ADD COLUMN "project_id" text;
--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "project_id" text;
--> statement-breakpoint
ALTER TABLE "renders" ADD COLUMN "project_id" text;
--> statement-breakpoint
UPDATE "videos" SET "project_id" = "projects"."id" FROM "projects" WHERE "projects"."org_id" = "videos"."org_id";
--> statement-breakpoint
UPDATE "templates" SET "project_id" = "projects"."id" FROM "projects" WHERE "projects"."org_id" = "templates"."org_id";
--> statement-breakpoint
UPDATE "renders" SET "project_id" = "projects"."id" FROM "projects" WHERE "projects"."org_id" = "renders"."org_id";
--> statement-breakpoint
ALTER TABLE "videos" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "templates" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "renders" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "videos" ADD CONSTRAINT "fk_videos_project" FOREIGN KEY ("project_id","org_id") REFERENCES "public"."projects"("id","org_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "fk_templates_project" FOREIGN KEY ("project_id","org_id") REFERENCES "public"."projects"("id","org_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "renders" ADD CONSTRAINT "fk_renders_project" FOREIGN KEY ("project_id","org_id") REFERENCES "public"."projects"("id","org_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_videos_project_id" ON "videos" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX "idx_templates_project_id" ON "templates" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX "idx_renders_project_id" ON "renders" USING btree ("project_id");
