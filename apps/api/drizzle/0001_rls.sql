-- Row-level security: plan §6's defense in depth.
--
-- `apps/api` scopes every query by org in application code. This layer exists
-- for the day it doesn't — one forgotten `WHERE org_id = …` is otherwise a
-- cross-tenant leak, and that is not a class of bug worth relying on review to
-- catch. With these policies in place the same mistake returns zero rows.
--
-- The mechanism, end to end:
--
--   1. `apps/api` authenticates the request and reads the session's active org
--   2. `withOrg()` (src/db/client.ts) opens a transaction and pins
--      `app.current_org_id` to it with `set_config(…, true)` — transaction
--      local, so a pooled connection cannot carry it into the next request
--   3. these policies compare `org_id` against that setting
--
-- Two details do the real work:
--
--   * `current_setting('app.current_org_id', true)` — the second argument is
--     `missing_ok`. Unset returns NULL, and `org_id = NULL` is never true, so
--     a query that forgot to go through `withOrg()` sees **nothing**. The
--     one-argument form would raise instead, which sounds stricter but is
--     worse: it makes "no org context" an error to handle rather than an
--     empty result, and errors get caught and swallowed.
--
--   * `FORCE ROW LEVEL SECURITY` — plain `ENABLE` exempts the table's owner,
--     and these tables are owned by the migration role. Without FORCE, a
--     future service that connects as the owner is silently unprotected while
--     `\d` still cheerfully lists the policies. (Superusers bypass RLS
--     regardless, which is why `src/db/bootstrap.ts` creates a NOSUPERUSER
--     role for serving requests and the test asserts that it is.)
--
-- WITH CHECK mirrors USING, so the boundary holds on writes too: an INSERT or
-- UPDATE that would stamp another tenant's `org_id` on a row is rejected
-- rather than accepted and then invisible.
--
-- The auth tables (users, sessions, accounts, verifications, organizations,
-- members, invitations) are deliberately NOT covered. They are not tenant
-- data and cannot be: sign-in has to find a user by email before any org
-- exists, and the org switcher has to list memberships before one is active.
-- Scoping there is per-user against the session and belongs to `better-auth`.
--
-- Keep this list in step with `TENANT_TABLES` in src/db/schema.ts — the
-- isolation test reads that constant and fails on any tenant table whose
-- policy is missing, so a new table cannot ship unprotected.

CREATE POLICY org_isolation ON projects
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

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

CREATE POLICY org_isolation ON lessons
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
ALTER TABLE lessons ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE lessons FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY org_isolation ON lesson_segments
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
ALTER TABLE lesson_segments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE lesson_segments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY org_isolation ON exports
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
ALTER TABLE exports ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE exports FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY org_isolation ON jobs
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY org_isolation ON org_settings
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
ALTER TABLE org_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE org_settings FORCE ROW LEVEL SECURITY;
