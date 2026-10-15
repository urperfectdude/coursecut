-- Row-level security for `zoom_regions`/`speed_regions`, the same
-- defense-in-depth 0002_rls_videos_jobs.sql establishes — see that
-- migration's header for the full mechanism. Both are `TENANT_TABLES`
-- entries (src/db/schema.ts), so they get the identical policy shape.
--
-- Keep this list in step with `TENANT_TABLES` in src/db/schema.ts.

CREATE POLICY org_isolation ON zoom_regions
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
ALTER TABLE zoom_regions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE zoom_regions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON speed_regions
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
ALTER TABLE speed_regions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE speed_regions FORCE ROW LEVEL SECURITY;
