CREATE TABLE "speed_regions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"video_id" text NOT NULL,
	"start" double precision NOT NULL,
	"end" double precision NOT NULL,
	"rate" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zoom_regions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"video_id" text NOT NULL,
	"start" double precision NOT NULL,
	"end" double precision NOT NULL,
	"scale" double precision NOT NULL,
	"focus_x" double precision NOT NULL,
	"focus_y" double precision NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "renders" ADD COLUMN "effects" jsonb;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "background_kind" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "background_color" text DEFAULT '#111827' NOT NULL;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "background_color2" text;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "background_key" text;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "frame_padding_px" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "frame_radius_px" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "frame_shadow" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "speed_regions" ADD CONSTRAINT "fk_speed_regions_video" FOREIGN KEY ("video_id","org_id") REFERENCES "public"."videos"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zoom_regions" ADD CONSTRAINT "fk_zoom_regions_video" FOREIGN KEY ("video_id","org_id") REFERENCES "public"."videos"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_speed_regions_video_id" ON "speed_regions" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX "idx_zoom_regions_video_id" ON "zoom_regions" USING btree ("video_id");