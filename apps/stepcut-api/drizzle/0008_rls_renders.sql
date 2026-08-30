-- Row-level security for `renders`/`render_steps` (Phase 5, this slice:
-- "Templates & render"), the same defense-in-depth 0002_rls_videos_jobs.sql
-- establishes for `videos`/`transcript_segments`/`jobs` — see that
-- migration's header for the full mechanism. Both tables are
-- `TENANT_TABLES` entries (src/db/schema.ts) exactly like those, so they get
-- the identical policy shape.
--
-- Keep this list in step with `TENANT_TABLES` in src/db/schema.ts.

CREATE POLICY org_isolation ON renders
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
ALTER TABLE renders ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE renders FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON render_steps
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
ALTER TABLE render_steps ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE render_steps FORCE ROW LEVEL SECURITY;
