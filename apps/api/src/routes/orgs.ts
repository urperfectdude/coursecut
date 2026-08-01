// The org switcher's data (plan §4.1) — a web-only surface with no desktop
// counterpart.
//
// This is deliberately *not* in `db.ts`'s world. §4.1 is explicit that session
// and org handling stay out of `db.ts`, because the moment a copied view can
// see auth state the two apps have stopped being the same product. So these
// routes are consumed only by `apps/web/src/auth/`, which sits above the view
// tree.
//
// Switching orgs goes through `better-auth`'s own
// `/api/auth/organization/set-active`, not through a route here — it writes
// the session column that `requireOrg` reads, and having two writers of the
// value the whole RLS mechanism keys on is not a thing worth having. This file
// only reads.

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
