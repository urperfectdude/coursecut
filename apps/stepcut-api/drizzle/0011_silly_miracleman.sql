ALTER TABLE "render_steps" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "render_steps" ADD COLUMN "asset_key" text;--> statement-breakpoint
ALTER TABLE "renders" ADD COLUMN "format" text DEFAULT 'video' NOT NULL;