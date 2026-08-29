CREATE TABLE "steps" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"video_id" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"start" double precision NOT NULL,
	"end" double precision NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"source" text DEFAULT 'ai' NOT NULL,
	"confidence" double precision,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "steps" ADD CONSTRAINT "fk_steps_video" FOREIGN KEY ("video_id","org_id") REFERENCES "public"."videos"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_steps_video_id" ON "steps" USING btree ("video_id");