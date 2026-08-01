// Who is calling, and which tenant they are calling as.
//
// Every route below this runs inside `withOrg()`, and `withOrg()` is only as
// trustworthy as the org id handed to it — so this file is where that id is
// established and nowhere else. The chain is:
//
//   session cookie → `better-auth` session → session.activeOrganizationId
//     → **re-checked against `members`** → `withOrg(orgId, …)`
//
// The re-check is the part worth arguing for. `better-auth`'s
// `setActiveOrganization` already validates membership before writing that
// column, so checking again looks redundant. It is not: that column is the
// single value the entire RLS mechanism keys on, and it is written by a code
// path the client can drive. One membership lookup per request is a cheap
// price for the property that a stale or tampered session id cannot select a
// tenant.
//
// Note also what does *not* happen here: no route handler ever reads the
// session. Plan §4.1 requires that no copied view sees auth state, and the
// server-side mirror of that rule is that org scoping is ambient — handlers
// get a `tx` that is already pinned, not a user object to filter by.

import type { Context, MiddlewareHandler } from "hono";
import { and, asc, eq } from "drizzle-orm";
import { getAuth } from "../auth.js";
import { getDb, withOrg, type Tx } from "../db/client.js";
import { members, sessions } from "../db/schema.js";
import { badRequest, forbidden, unauthorized } from "./errors.js";

export interface AppEnv {
  Variables: {
    userId: string;
    orgId: string;
    /** The caller's role in the active org — "owner" | "admin" | "member". */
    role: string;
  };
}

export type AppContext = Context<AppEnv>;

/**
 * Rejects anything without a valid session and an org the caller is actually
 * a member of. Mounted on `/api/*` except the auth routes themselves.
 */
export const requireOrg: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = await getAuth().api.getSession({ headers: c.req.raw.headers });
  if (!session) throw unauthorized();

  const userId = session.user.id;
  const activeOrgId = session.session.activeOrganizationId;

  const membership = activeOrgId ? await findMembership(userId, activeOrgId) : undefined;
  const resolved = membership
    ? { orgId: activeOrgId!, role: membership.role }
    : await adoptDefaultOrg(userId, session.session.id);

  c.set("userId", userId);
  c.set("orgId", resolved.orgId);
  c.set("role", resolved.role);
  await next();
};

function findMembership(userId: string, orgId: string) {
  return getDb()
    .select({ role: members.role })
    .from(members)
    .where(and(eq(members.userId, userId), eq(members.organizationId, orgId)))
    .limit(1)
    .then(([row]) => row);
}

/**
 * Picks an org for a session that has none, and writes it back.
 *
 * A session normally gets its active org when it is created (see `auth.ts`),
 * so reaching here means something cleared it. That is not hypothetical:
 * `better-auth`'s `set-active` clears the column as part of *rejecting* a
 * switch to an org the user does not belong to. Without this fallback the
 * refusal — correct in itself — would lock the user out of the org they were
 * already in until they signed out and back in, which reads as data loss
 * rather than as a declined request.
 *
 * Oldest membership wins, the same rule sign-in uses, so the recovery lands
 * somewhere predictable rather than somewhere arbitrary. A user with no
 * memberships at all is a real 403 — RLS would return empty rows instead,
 * which looks identical to having lost everything.
 */
async function adoptDefaultOrg(userId: string, sessionId: string) {
  const [fallback] = await getDb()
    .select({ organizationId: members.organizationId, role: members.role })
    .from(members)
    .where(eq(members.userId, userId))
    .orderBy(asc(members.createdAt))
    .limit(1);
  if (!fallback) throw forbidden("This account does not belong to an organization yet.");

  await getDb()
    .update(sessions)
    .set({ activeOrganizationId: fallback.organizationId })
    .where(eq(sessions.id, sessionId));

  return { orgId: fallback.organizationId, role: fallback.role };
}

/**
 * A required path parameter.
 *
 * Hono types `c.req.param()` as possibly-undefined when the path is not a
 * literal in the same expression (which it is not in a factory like
 * `exports.ts`'s `transition`). It cannot actually be missing — the route
 * would not have matched — so this narrows rather than defends.
 */
export function param(c: AppContext, name: string): string {
  const value = c.req.param(name);
  if (value === undefined) throw badRequest(`missing path parameter ${name}`);
  return value;
}

/**
 * Runs `fn` in a transaction pinned to the caller's org. The only way a route
 * handler touches a tenant table.
 */
export function tx<T>(c: AppContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withOrg(c.get("orgId"), fn);
}

/** Every org the caller belongs to — the org switcher's data (plan §4.1). */
export async function listMemberships(userId: string) {
  return getDb().query.members.findMany({
    where: eq(members.userId, userId),
    orderBy: asc(members.createdAt),
    with: { organization: true },
  });
}
