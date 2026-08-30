-- Row-level security for `templates` (Phase 5, slice 1: "Templates &
-- render"), the same defense-in-depth 0002_rls_videos_jobs.sql establishes
-- for `videos`/`transcript_segments`/`jobs` — see that migration's header for
-- the full mechanism. `templates` is a `TENANT_TABLES` entry
-- (src/db/schema.ts) exactly like those, so it gets the identical policy
-- shape.
--
-- Keep this list in step with `TENANT_TABLES` in src/db/schema.ts.

CREATE POLICY org_isolation ON templates
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
ALTER TABLE templates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE templates FORCE ROW LEVEL SECURITY;
