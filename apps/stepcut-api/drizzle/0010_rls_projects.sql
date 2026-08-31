-- Row-level security for `projects` — the same defense-in-depth
-- 0002_rls_videos_jobs.sql establishes for `videos`/`transcript_segments`/
-- `jobs` — see that migration's header for the full mechanism. `projects` is
-- a `TENANT_TABLES` entry (src/db/schema.ts) exactly like those, so it gets
-- the identical policy shape.
--
-- Keep this list in step with `TENANT_TABLES` in src/db/schema.ts.

CREATE POLICY org_isolation ON projects
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
