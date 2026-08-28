// The org switcher's data — a web-only surface with no desktop counterpart
// (StepCut has no desktop counterpart at all).
//
// Copied from apps/api/src/routes/orgs.ts. Switching orgs goes through
// `better-auth`'s own `/api/auth/organization/set-active`, not through a
// route here — it writes the session column that `requireOrg` reads, and
// having two writers of the value the tenancy mechanism keys on is not a
// thing worth having. This file only reads.

import { Hono } from "hono";
import { listMemberships, type AppEnv } from "../http/context.js";

export const orgRoutes = new Hono<AppEnv>();

/**
 * The caller's orgs and which one is active.
 *
 * `organizations` is not RLS-covered and cannot be — listing a user's
 * memberships is exactly the query that has to work *before* an org is
 * active. Scoping here is per-user, done by the `where user_id = …` below,
 * which is `better-auth`'s model rather than Postgres's.
 */
orgRoutes.get("/orgs", async (c) => {
  const memberships = await listMemberships(c.get("userId"));
  return c.json({
    active_org_id: c.get("orgId"),
    orgs: memberships.map((membership) => ({
      id: membership.organizationId,
      name: membership.organization.name,
      slug: membership.organization.slug,
      role: membership.role,
    })),
  });
});
