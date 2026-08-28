// StepCut's Postgres schema — Phase 1 (docs/stepcut-plan.md §8: "Scaffold").
//
// Lean by design (plan decision 2): only the seven better-auth/org tables
// plus `api_keys`. `videos`/`transcript_segments`/`jobs` arrive in Phase 2,
// `steps` in Phase 3, `templates`/`renders`/`render_steps` in Phase 5. No
// stub tables now.
//
// Conventions, copied from apps/api/src/db/schema.ts:
//
//  * Ids are `text`, not `uuid` — `better-auth` mints its own ids and they
//    are not UUIDs.
//  * `created_at`/`updated_at` are `timestamptz`.
//  * Every future tenant-scoped row will carry `org_id` directly, so an RLS
//    policy is a single-column check rather than a join — see `TENANT_TABLES`
//    at the bottom of this file for why nothing is in that list yet.

import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

// Shorthands for the column shapes that repeat on nearly every table.
const id = () => text("id").primaryKey();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------------------
// Auth + tenancy — owned by `better-auth` (core + organization plugin)
// ---------------------------------------------------------------------------
//
// These tables are shaped to `better-auth`'s documented schema but named in
// this codebase's conventions: plural table names (`user` is a reserved word
// in Postgres) and snake_case columns (everything else here is snake_case).
//
// `npm run auth:generate` is the authority on these seven tables; this file
// is that generator's output hand-reconciled the same way apps/api's schema
// is (see that file's header): `usePlural: true` in `src/auth.ts` maps
// `user` → `users`, `session` → `sessions`, … all seven, and no column
// mapping at all, because the Drizzle adapter addresses columns by each
// table's JavaScript property name, which is already the camelCase name
// `better-auth` uses (`userId`, `expiresAt`, `activeOrganizationId`).
//
// Three deliberate differences from the generated output, all additive,
// mirroring apps/api's:
//
//   * `timestamptz` rather than naked `timestamp`.
//   * `defaultNow()` on `organizations.created_at` / `members.created_at`.
//   * Two extra UNIQUE constraints — `uq_members_org_user` and
//     `uq_accounts_provider_account` — for invariants the app relies on (one
//     membership per user per org; one account per provider identity).
//
// None of them carry RLS. They are not tenant-scoped data: sign-in has to
// find a user by email before any org context exists, and the org switcher
// has to list a user's memberships before one is active. Scoping here is
// `better-auth`'s job, done per-user against the session.

export const users = pgTable("users", {
  id: id(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    // Added by the organization plugin: which org this session is acting as.
    // This is the value `apps/stepcut-api` will feed to `app.current_org_id`
    // on every request once RLS is real (Phase 2+), after checking the
    // session actually has a membership in it.
    activeOrganizationId: text("active_organization_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("idx_sessions_user_id").on(t.userId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    // Hashed by `better-auth`, never by us.
    password: text("password"),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    idToken: text("id_token"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("idx_accounts_user_id").on(t.userId),
    unique("uq_accounts_provider_account").on(t.providerId, t.accountId),
  ],
);

export const verifications = pgTable(
  "verifications",
  {
    id: id(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("idx_verifications_identifier").on(t.identifier)],
);

/** The tenant. Everything domain-specific in later phases hangs off this by
 * `org_id`. */
export const organizations = pgTable("organizations", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  metadata: text("metadata"),
  createdAt: createdAt(),
});

export const members = pgTable(
  "members",
  {
    id: id(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // "owner" | "admin" | "member" — `better-auth`'s vocabulary.
    role: text("role").notNull().default("member"),
    createdAt: createdAt(),
  },
  (t) => [
    // One membership row per (user, org) — the uniqueness the org switcher
    // and every permission check assume.
    unique("uq_members_org_user").on(t.organizationId, t.userId),
    index("idx_members_user_id").on(t.userId),
  ],
);

export const invitations = pgTable(
  "invitations",
  {
    id: id(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role"),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("idx_invitations_org_id").on(t.organizationId),
    index("idx_invitations_email").on(t.email),
  ],
);

// ---------------------------------------------------------------------------
// API keys — Phase 1's one domain table
// ---------------------------------------------------------------------------

/**
 * A bearer key an org can mint for programmatic access (Phase 1 scaffolds the
 * table; nothing issues or verifies keys yet).
 *
 * Plain FK to `organizations`, **not RLS-covered** — see `TENANT_TABLES`
 * below for why.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // Never the raw key — only its hash is stored, so a database read alone
    // cannot recover a usable credential.
    keyHash: text("key_hash").notNull().unique(),
    // The first several characters of the raw key, shown back to the user so
    // they can recognise which key is which without ever seeing the rest of
    // it again.
    keyPrefix: text("key_prefix").notNull(),
    name: text("name").notNull(),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("idx_api_keys_org_id").on(t.orgId)],
);

// ---------------------------------------------------------------------------
// Relations — for Drizzle's query API; no effect on the generated DDL.
// Only what `http/context.ts`'s `listMemberships` actually queries
// (`members.findMany({ with: { organization: true } })`); more get added
// alongside whatever later phases need.
// ---------------------------------------------------------------------------

export const organizationsRelations = relations(organizations, ({ many }) => ({
  members: many(members),
}));

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  accounts: many(accounts),
  memberships: many(members),
}));

export const membersRelations = relations(members, ({ one }) => ({
  organization: one(organizations, {
    fields: [members.organizationId],
    references: [organizations.id],
  }),
  user: one(users, { fields: [members.userId], references: [users.id] }),
}));

/**
 * The tables RLS must cover — every table holding tenant data that is looked
 * up *after* the caller's org is already known. Empty in Phase 1, and
 * deliberately so on both counts:
 *
 *   * No domain tables exist yet (plan decision 2) — `videos`/`jobs`/`steps`
 *     etc. arrive in later phases and will be added here alongside their own
 *     migration.
 *   * `api_keys` is deliberately **not** in this list even though it is
 *     tenant data. Verifying a bearer key means finding its row by
 *     `key_hash` *before* any org is known — the same chicken-and-egg
 *     problem that keeps `users`/`sessions` out of RLS above: RLS keyed on
 *     `app.current_org_id` can only filter once the org is already set, not
 *     discover it. So `api_keys` sits alongside the auth tables: a plain
 *     `org_id` FK, no policy, looked up directly by the (future)
 *     `requireApiKey` middleware, which then calls `withOrg(row.orgId, ...)`
 *     for everything downstream of that lookup.
 */
export const TENANT_TABLES = [] as const;
