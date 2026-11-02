-- Row-level security for `transcript_words`, the same defense-in-depth
-- 0002_rls_videos_jobs.sql establishes — see that migration's header for the
-- full mechanism. It is a `TENANT_TABLES` entry (src/db/schema.ts), so it
-- gets the identical policy shape.
--
-- Keep this list in step with `TENANT_TABLES` in src/db/schema.ts.

CREATE POLICY org_isolation ON transcript_words
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
ALTER TABLE transcript_words ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE transcript_words FORCE ROW LEVEL SECURITY;
