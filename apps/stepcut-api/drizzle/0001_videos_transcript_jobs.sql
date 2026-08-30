CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"video_id" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"progress" double precision,
	"detail" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcript_segments" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"video_id" text NOT NULL,
	"start" double precision NOT NULL,
	"end" double precision NOT NULL,
	"text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "videos" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"upload_status" text DEFAULT 'pending' NOT NULL,
	"duration" double precision,
	"transcript_status" text DEFAULT 'pending' NOT NULL,
	"content_hash" text,
	"audio_key" text,
	"size_bytes" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_videos_id_org" UNIQUE("id","org_id")
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "fk_jobs_video" FOREIGN KEY ("video_id","org_id") REFERENCES "public"."videos"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD CONSTRAINT "fk_transcript_segments_video" FOREIGN KEY ("video_id","org_id") REFERENCES "public"."videos"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_jobs_video_id" ON "jobs" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX "idx_jobs_org_state" ON "jobs" USING btree ("org_id","state");--> statement-breakpoint
CREATE INDEX "idx_transcript_segments_video_id" ON "transcript_segments" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX "idx_videos_org_id" ON "videos" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_videos_org_content_hash" ON "videos" USING btree ("org_id","content_hash");