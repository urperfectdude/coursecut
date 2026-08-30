CREATE TABLE "render_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"render_id" text NOT NULL,
	"step_id" text,
	"sort_order" integer NOT NULL,
	"start" double precision NOT NULL,
	"end" double precision NOT NULL,
	"title" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "renders" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"video_id" text NOT NULL,
	"template_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress" double precision,
	"output_key" text,
	"error" text,
	"callback_url" text,
	"size_bytes" bigint,
	"download_expires_at" timestamp with time zone,
	"webhook_status" text,
	"webhook_attempts" integer DEFAULT 0 NOT NULL,
	"webhook_last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_renders_id_org" UNIQUE("id","org_id")
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "render_id" text;--> statement-breakpoint
ALTER TABLE "render_steps" ADD CONSTRAINT "render_steps_step_id_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_steps" ADD CONSTRAINT "fk_render_steps_render" FOREIGN KEY ("render_id","org_id") REFERENCES "public"."renders"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renders" ADD CONSTRAINT "fk_renders_video" FOREIGN KEY ("video_id","org_id") REFERENCES "public"."videos"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renders" ADD CONSTRAINT "fk_renders_template" FOREIGN KEY ("template_id","org_id") REFERENCES "public"."templates"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_render_steps_render_id" ON "render_steps" USING btree ("render_id");--> statement-breakpoint
CREATE INDEX "idx_renders_org_id" ON "renders" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_renders_video_id" ON "renders" USING btree ("video_id");--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "fk_jobs_render" FOREIGN KEY ("render_id","org_id") REFERENCES "public"."renders"("id","org_id") ON DELETE cascade ON UPDATE no action;