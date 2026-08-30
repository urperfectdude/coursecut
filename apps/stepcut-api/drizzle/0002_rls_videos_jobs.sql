-- Row-level security: the same defense-in-depth apps/api/drizzle/0001_rls.sql
-- establishes for coursecut-web, applied fresh to StepCut's own three
-- tenant tables (`TENANT_TABLES` in src/db/schema.ts).
--
-- `apps/stepcut-api` scopes every query by org in application code
-- (`withOrg()` in src/db/client.ts). This layer exists for the day it
-- doesn't — one forgotten `WHERE org_id = …` is otherwise a cross-tenant
-- leak, and that is not a class of bug worth relying on review to catch.
-- With these policies in place the same mistake returns zero rows.
--
-- The mechanism, end to end:
--
--   1. `apps/stepcut-api` authenticates the request and reads the session's
--      active org (`requireOrg` in src/http/context.ts)
--   2. `withOrg()` opens a transaction and pins `app.current_org_id` to it
--      with `set_config(…, true)` — transaction local, so a pooled
--      connection cannot carry it into the next request
--   3. these policies compare `org_id` against that setting
--
-- Two details do the real work:
--
--   * `current_setting('app.current_org_id', true)` — the second argument is
--     `missing_ok`. Unset returns NULL, and `org_id = NULL` is never true, so
--     a query that forgot to go through `withOrg()` sees **nothing**.
--
--   * `FORCE ROW LEVEL SECURITY` — plain `ENABLE` exempts the table's owner,
--     and these tables are owned by the migration role. Without FORCE, a
--     future service that connects as the owner is silently unprotected.
--
-- WITH CHECK mirrors USING, so the boundary holds on writes too.
--
-- The auth tables and `api_keys` are deliberately NOT covered — see
-- `TENANT_TABLES`'s own comment in src/db/schema.ts for why `api_keys` in
-- particular cannot be (verifying a bearer key has to find its row before
-- any org is known).
--
-- Keep this list in step with `TENANT_TABLES` in src/db/schema.ts.

CREATE POLICY org_isolation ON videos
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
ALTER TABLE videos ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE videos FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY org_isolation ON transcript_segments
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
ALTER TABLE transcript_segments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE transcript_segments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY org_isolation ON jobs
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
