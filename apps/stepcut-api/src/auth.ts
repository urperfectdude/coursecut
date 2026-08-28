// Authentication and tenancy — the StepCut instance, kept deliberately
// minimal for Phase 1 (docs/stepcut-plan.md §8).
//
// `better-auth` owns sessions, password hashing and the organization model,
// same as apps/api/src/auth.ts. There is no crypto in this file, only
// configuration.
//
// **Schema mapping.** `src/db/schema.ts` hand-shapes the seven auth tables to
// this codebase's conventions (plural table names — `user` is reserved in
// Postgres — and snake_case columns). Two knobs reconcile that with the
// library's model names:
//
//   * `usePlural: true` maps model `user` → table `users`, `session` →
//     `sessions`, and so on for all seven.
//   * Nothing maps the columns, because nothing needs to: the Drizzle adapter
//     addresses columns by the table object's *JavaScript* property names,
//     which are already the camelCase names `better-auth` uses.
//
// **The active org is the tenancy boundary**, same as coursecut's — the
// organization plugin stores it on the session row
// (`sessions.active_organization_id`), and `http/context.ts` feeds exactly
// that value to callers after re-checking the membership.
//
// **What Phase 1 deliberately leaves out**, vs. apps/api/src/auth.ts:
//
//   * No `sendResetPassword` / mail config — there is no `mail.ts` yet, so
//     password reset does not exist (unset is `better-auth`'s own "no reset
//     flow" behaviour, not a bug).
//   * No `organizationHooks` (`assertOrgAllowanceLeft`) — no quota table to
//     check against yet. Org-count limiting is a later hardening concern.
//   * No `deleteUser` hooks (`assertUserIsDeletable`, `purgeOrgsOwnedBy`) —
//     those depend on `retention.ts`, which does not exist in Phase 1.
//   * No `rateLimit` block — `http/rate-limit.ts` is copied but unwired (see
//     that file's header); the same applies to `better-auth`'s own limiter
//     here, which nothing yet makes worth turning on.
//
// **`organizationCreation: { disabled: false }` only *permits* manual
// creation — it does not auto-create an org at signup.** There is no
// `user.create` hook here that would do that, on either app: a fresh session
// has zero memberships until someone explicitly creates or joins an org (see
// `docs/stepcut-plan.md`'s design decision 10, confirmed against
// apps/web/src/auth/SessionGate.tsx's real `orgs.length === 0` branch).

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { env } from "./env.js";
import { getDb } from "./db/client.js";
import * as schema from "./db/schema.js";

/**
 * Built lazily so importing this module never opens a database connection —
 * the same rule `db/client.ts` follows, and what keeps `migrate`/`bootstrap`
 * from dragging the auth stack in.
 */
let instance: ReturnType<typeof build> | undefined;

function build() {
  return betterAuth({
    secret: env.authSecret(),
    baseURL: env.appUrl(),
    // The SPA calls `/api/auth/*`; in dev Vite proxies that to this server,
    // in production Caddy does. Same-origin either way, so the session cookie
    // is a plain first-party httpOnly cookie.
    basePath: "/api/auth",
    trustedOrigins: [env.appUrl()],

    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema,
      usePlural: true,
    }),

    emailAndPassword: {
      enabled: true,
      // No mail driver in Phase 1, so no verification and no reset flow —
      // a reset form whose mail never arrives is worse than no form at all.
      requireEmailVerification: false,
    },

    plugins: [
      organization({
        creatorRole: "owner",
        // Permits manual org creation; does not create one automatically —
        // see this file's header.
        organizationCreation: { disabled: false },
      }),
    ],

    // Every session carries its active org, which callers pin queries to.
    // Set at sign-in below, because a session with no active org can read
    // nothing at all and would look like data loss.
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
                // they started rather than somewhere arbitrary. A session
                // with no memberships gets `null`, which is the expected
                // state right after signup, before `CreateOrgScreen` runs.
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
