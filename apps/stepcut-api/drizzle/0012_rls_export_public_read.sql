-- A second, narrower policy on `renders`/`render_steps` — additive to
-- 0008_rls_renders.sql's `org_isolation`, not a replacement for it.
--
-- `routes/exports-public.ts` (the unauthenticated `GET /api/exports/...`
-- route a `'markdown'`/`'html'`-format render's embedded links point at) has
-- no org context to scope a `withOrg(...)` transaction with — the whole
-- point of that route is that it works with no session at all. Reading
-- through `getDb()` instead, with `app.current_org_id` unset, does not widen
-- access under `org_isolation`; per `db/client.ts`'s own header, it returns
-- *zero* rows ("you do not get more rows, you get none... forgetting to
-- scope fails closed"). Without this policy, the route always 404s
-- regardless of the render's real state — RLS is enforced for the
-- connecting role no matter which application code path is asking.
--
-- Postgres ORs together every PERMISSIVE policy on a table (the default
-- policy type — `org_isolation` never specified otherwise), so this policy
-- doesn't loosen `org_isolation`'s own guarantee: a signed-in request is
-- still exactly as scoped as before. It only adds a second, narrow way for a
-- row to be visible — the org's *own choice*, made at render-creation time,
-- to publish this specific one. `FOR SELECT` only, deliberately: publishing
-- is a read-visibility grant, never a write path, so this must never carry a
-- `WITH CHECK` that could let an unscoped insert/update through.
--
-- `render_steps` has no `status`/`format` of its own to check directly — a
-- step is only meant to be publicly readable once its owning render is
-- `'done'` and published, so its policy is expressed as an `EXISTS` against
-- `renders`. That subquery runs under this same OR'd-policy set, so it sees
-- exactly the same public renders this migration's other policy makes
-- visible — no separate bypass needed for it to succeed.

CREATE POLICY public_export_read ON renders
  FOR SELECT
  USING (status = 'done' AND format IN ('markdown', 'html'));
--> statement-breakpoint
CREATE POLICY public_export_read ON render_steps
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM renders r
      WHERE r.id = render_steps.render_id
        AND r.status = 'done'
        AND r.format IN ('markdown', 'html')
    )
  );
