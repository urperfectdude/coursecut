CREATE TABLE "templates" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"intro_key" text,
	"outro_key" text,
	"logo_key" text,
	"brand_primary_hex" text,
	"brand_secondary_hex" text,
	"target_width" integer DEFAULT 1920 NOT NULL,
	"target_height" integer DEFAULT 1080 NOT NULL,
	"target_fps" integer DEFAULT 30 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_templates_id_org" UNIQUE("id","org_id")
);
--> statement-breakpoint
CREATE INDEX "idx_templates_org_id" ON "templates" USING btree ("org_id");