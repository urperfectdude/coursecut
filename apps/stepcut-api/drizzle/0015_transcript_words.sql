CREATE TABLE "transcript_words" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"video_id" text NOT NULL,
	"idx" integer NOT NULL,
	"text" text NOT NULL,
	"start" double precision NOT NULL,
	"end" double precision NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"original_text" text
);
--> statement-breakpoint
ALTER TABLE "transcript_words" ADD CONSTRAINT "fk_transcript_words_video" FOREIGN KEY ("video_id","org_id") REFERENCES "public"."videos"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_transcript_words_video_idx" ON "transcript_words" USING btree ("video_id","idx");