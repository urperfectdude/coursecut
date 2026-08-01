// Authentication and tenancy (plan D8, §4.1).
//
// `better-auth` owns sessions, password hashing and the organization model.
// Plan §7 is explicit that this is the one place M3 adds net-new
// security-sensitive code and that the library's defaults beat anything
// hand-rolled — so there is deliberately no crypto in this file, only
// configuration.
//
// **Schema mapping.** M2 hand-shaped the seven auth tables in `db/schema.ts`
// to this codebase's conventions (plural table names — `user` is reserved in
// Postgres — and snake_case columns). Two knobs reconcile that with the
// library's model names:
//
//   * `usePlural: true` maps model `user` → table `users`, `session` →
//     `sessions`, and so on for all seven.
//   * Nothing maps the columns, because nothing needs to: the Drizzle adapter
//     addresses columns by the table object's *JavaScript* property names,
//     which are already the camelCase names `better-auth` uses
//     (`userId`, `expiresAt`, `activeOrganizationId`, …). The snake_case is
//     the SQL name Drizzle emits, and the adapter never sees it.
//
// `npx @better-auth/cli generate` is the authority on those tables (schema.ts
// says so); running it against this config is the check that the mapping
// above is complete.
//
// **The active org is the tenancy boundary.** The organization plugin stores
// it on the session row (`sessions.active_organization_id`), and
// `http/context.ts` feeds exactly that value to `withOrg()` — after
// re-checking the membership, because a session column is a client-influenced
// value and RLS is only as good as what it is handed.

import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { and, eq, sql } from "drizzle-orm";
import { env } from "./env.js";
import { getDb } from "./db/client.js";
import * as schema from "./db/schema.js";
import { isMailConfigured, passwordResetMessage, send } from "./mail.js";
import { purgeOrgObjects } from "./retention.js";

/**
 * Built lazily so importing this module never opens a database connection —
 * the same rule `db/client.ts` follows, and what keeps `migrate`/`seed` from
 * dragging the auth stack in.
 */
let instance: ReturnType<typeof build> | undefined;

function build() {
  return betterAuth({
    secret: env.authSecret(),
    baseURL: env.appUrl(),
    // The SPA calls `/api/auth/*`; in dev Vite proxies that to this server,
    // in production Caddy does. Same-origin either way, so the session cookie
    // is a plain first-party httpOnly cookie and there is no CORS path that
    // only exists locally (plan §5).
    basePath: "/api/auth",
    trustedOrigins: [env.appUrl()],

    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema,
      usePlural: true,
    }),

    emailAndPassword: {
      enabled: true,
      // Still off, and now for a narrower reason than before: verification
      // would gate sign-in on a mail arriving, and mail is optional here
      // (`MAIL_DRIVER` unset is a supported deployment). Password reset, which
      // is opt-in per attempt rather than in the path of every signup, is the
      // one that could be made conditional — see below.
      requireEmailVerification: false,
      // Configured only when mail can actually be delivered. `better-auth`
      // refuses the reset request outright when this is absent, which is the
      // behaviour wanted: with no provider there is no reset flow, no form,
      // and no link — not a form that silently fails (M7's `mail.ts` header,
      // and D7's reasoning about the desktop key UI).
      ...(isMailConfigured()
        ? {
            sendResetPassword: async ({ user, url }) => {
              await send(passwordResetMessage(user.email, url));
            },
            // A reset is how someone reacts to thinking their password leaked,
            // so it takes every existing session with it — same rule
            // `AccountDialog`'s password change already follows.
            revokeSessionsOnPasswordReset: true,
          }
        : {}),
    },

    user: {
      // `users` is not RLS-covered (it cannot be — sign-in has to find a user
      // by email before any org context exists), so deleting one has to be
      // deliberate. M7 owns account deletion, and this is it.
      deleteUser: {
        enabled: true,
        // No verification mail: deletion requires the session and — because
        // `better-auth` asks for it on this endpoint — the account's current
        // password, which is a stronger check than possession of an inbox.
        beforeDelete: assertUserIsDeletable,
        afterDelete: purgeOrgsOwnedBy,
      },
    },

    // Brute-force and abuse limiting on the auth surface (M7).
    //
    // `better-auth`'s own limiter rather than the API's (`http/rate-limit.ts`),
    // because these routes are mounted before `requireOrg` and have no user to
    // key on — the library keys by IP, which is the only identity a sign-in
    // attempt has. Memory storage is deliberate at this scale: one API
    // container (plan §3.3), and a limiter that survives a restart is worth
    // less than one that costs no round trip. Moving to `storage: "database"`
    // needs the library's `rateLimit` table and is the thing to change when
    // the API is scaled out, not before.
    rateLimit: {
      enabled: true,
      window: 60,
      max: 120,
      customRules: {
        // The three that are worth guessing at: two credential endpoints and
        // the one that sends mail to an address the caller chose.
        "/sign-in/email": { window: 60, max: 10 },
        "/sign-up/email": { window: 3600, max: 5 },
        "/request-password-reset": { window: 3600, max: 5 },
        "/forget-password": { window: 3600, max: 5 },
      },
    },

    plugins: [
      organization({
        // Plan §4.1 starts on owner/member; the column is unconstrained so
        // adopting `admin` later costs no migration.
        creatorRole: "owner",
        // A new signup gets an org immediately, so a single-user tenant never
        // sees an empty "pick an organization" step the desktop app has no
        // counterpart for.
        organizationCreation: { disabled: false },
        organizationHooks: {
          beforeCreateOrganization: assertOrgAllowanceLeft,
          // Rows go by ON DELETE CASCADE; objects do not, and after the org
          // row is gone there is nothing left to find them from — the
          // retention sweep walks orgs, and this one no longer exists.
          afterDeleteOrganization: async ({ organization: org }) => {
            const purged = await purgeOrgObjects(org.id).catch((err: unknown) => {
              console.error(`[auth] purging storage for deleted org ${org.id} failed`, err);
              return 0;
            });
            console.log(`[auth] org ${org.id} deleted, ${purged} object(s) purged`);
          },
        },
      }),
    ],

    // Every session carries its active org, which is what `withOrg()` pins.
    // Set at sign-in below, because a session with no active org can read
    // nothing at all (RLS fails closed) and would look like data loss.
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const [membership] = await getDb()
              .select({ organizationId: schema.members.organizationId })
              .from(schema.members)
              .where(eq(schema.members.userId, session.userId))
              .orderBy(schema.members.createdAt)
              .limit(1);
            return {
              data: {
                ...session,
                // Oldest membership wins, so a multi-org user lands where
                // they started rather than somewhere arbitrary. The org
                // switcher (§4.1) changes it from there.
                activeOrganizationId: membership?.organizationId ?? null,
              },
            };
          },
        },
      },
    },
  });
}

export function getAuth() {
  instance ??= build();
  return instance;
}

export type Auth = ReturnType<typeof getAuth>;

// ---------------------------------------------------------------------------
// M7 hooks
// ---------------------------------------------------------------------------

/**
 * Caps how many orgs one user may create.
 *
 * Without this, "sign up again" is a quota reset: every new org gets a fresh
 * monthly transcription allowance and a fresh storage ceiling, and creating
 * one costs a form submission. That makes every other limit in `quota.ts`
 * advisory, which is why this lives here rather than being deferred as a
 * hardening detail.
 *
 * It counts *owned* orgs, not memberships — being invited into ten
 * organizations is normal collaboration and costs nothing, while owning ten is
 * how the meter gets gamed.
 */
async function assertOrgAllowanceLeft({ user }: { user: { id: string } }): Promise<void> {
  const max = env.quotaMaxOrgsPerUser();
  const [row] = await getDb()
    .select({ owned: sql<number>`count(*)::int` })
    .from(schema.members)
    .where(and(eq(schema.members.userId, user.id), eq(schema.members.role, "owner")));

  if ((row?.owned ?? 0) >= max) {
    throw new APIError("FORBIDDEN", {
      message:
        `This account already owns ${max} organizations, which is the limit. ` +
        `Delete one you no longer need, or ask support to raise it.`,
    });
  }
}

/**
 * Refuses to delete a user who is the last owner of an org that still has
 * members.
 *
 * The alternative — deleting the org along with them — would take other
 * people's projects with it because one of them left. So the account holder is
 * told to hand ownership over or remove the members first, and only orgs that
 * are theirs alone are cleaned up (below).
 */
async function assertUserIsDeletable(user: { id: string }): Promise<void> {
  const owned = await getDb()
    .select({ organizationId: schema.members.organizationId })
    .from(schema.members)
    .where(and(eq(schema.members.userId, user.id), eq(schema.members.role, "owner")));

  const soleOwned: string[] = [];
  for (const membership of owned) {
    const [others] = await getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.members)
      .where(
        and(
          eq(schema.members.organizationId, membership.organizationId),
          sql`${schema.members.userId} <> ${user.id}`,
        ),
      );
    if ((others?.count ?? 0) > 0) {
      throw new APIError("BAD_REQUEST", {
        message:
          "This account is the only owner of an organization that still has other members. " +
          "Make someone else an owner, or remove the other members, before deleting it.",
      });
    }
    soleOwned.push(membership.organizationId);
  }

  // Handed to `afterDelete`, which cannot work this out for itself: by the
  // time it runs, `members` has cascaded away and the user's orgs are
  // indistinguishable from anyone else's empty ones.
  pendingOrgPurges.set(user.id, soleOwned);
}

/**
 * Orgs to purge once the account deletion commits, keyed by user id.
 *
 * In memory rather than in a table because it lives for the length of one
 * request: `beforeDelete` writes it, `afterDelete` reads and clears it, and a
 * process that dies between the two has not deleted the user either.
 */
const pendingOrgPurges = new Map<string, string[]>();

/**
 * After the account is gone, delete the orgs it was alone in — rows and
 * objects both.
 *
 * `members` cascades from `users`, so by the time this runs those orgs have no
 * members at all: they are unreachable, and their video would sit in storage
 * being paid for forever. Plan §9 promises deletion purges, and an account
 * deletion that left the tenant's video behind would not be that.
 *
 * Best-effort and logged: the account is already deleted and cannot be brought
 * back to retry this, so failing loudly here would only turn a successful
 * deletion into an error message. The orphan sweep is not a backstop for it
 * (it walks existing orgs), so the log line is the operator's signal.
 */
async function purgeOrgsOwnedBy(user: { id: string }): Promise<void> {
  const abandoned = pendingOrgPurges.get(user.id) ?? [];
  pendingOrgPurges.delete(user.id);

  for (const orgId of abandoned) {
    try {
      await purgeOrgObjects(orgId);
      // Everything tenant-scoped cascades from this row: projects, videos,
      // transcripts, lessons, exports, jobs, settings and the usage ledger.
      await getDb().delete(schema.organizations).where(eq(schema.organizations.id, orgId));
      console.log(`[auth] purged org ${orgId}, left with no members after a user deletion`);
    } catch (err) {
      console.error(`[auth] purging abandoned org ${orgId} failed`, err);
    }
  }
}
