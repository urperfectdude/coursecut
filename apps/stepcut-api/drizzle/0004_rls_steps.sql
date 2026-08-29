-- Row-level security for `steps` (Phase 3), the same defense-in-depth
-- 0002_rls_videos_jobs.sql establishes for `videos`/`transcript_segments`/
-- `jobs` — see that migration's header for the full mechanism. `steps` is a
-- `TENANT_TABLES` entry (src/db/schema.ts) exactly like those three, so it
-- gets the identical policy shape.
--
-- Keep this list in step with `TENANT_TABLES` in src/db/schema.ts.

CREATE POLICY org_isolation ON steps
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
ALTER TABLE steps ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE steps FORCE ROW LEVEL SECURITY;
