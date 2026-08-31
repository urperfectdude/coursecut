// StepCut's Postgres schema.
//
// Phase 1 (docs/stepcut-plan.md §8: "Scaffold") shipped only the seven
// better-auth/org tables plus `api_keys`. Phase 2 ("Upload & transcript")
// added `videos`, `transcript_segments` and `jobs` together — trimmed to what
// Phase 2 needed (no `keep` column on transcript segments; see
// docs/stepcut-plan.md's Phase 2 section for the full list of deltas from
// apps/api's copy of this same shape). Phase 3 ("AI step proposal") adds
// `steps` and extends `jobs.kind` with `'analyze'`. Phase 5 ("Templates &
// render") added `templates` in its first slice; this slice adds
// `renders`/`render_steps` and extends `jobs` with `renderId` and
// `jobs.kind`'s `'render'` value.
//
// Conventions, copied from apps/api/src/db/schema.ts:
//
//  * Ids are `text`, not `uuid` — `better-auth` mints its own ids and they
//    are not UUIDs.
//  * `created_at`/`updated_at` are `timestamptz`.
//  * Every tenant-scoped row carries `org_id` directly, so an RLS policy is a
//    single-column check rather than a join — that stays true even now that
//    `videos`/`templates`/`renders` also carry a `project_id`: RLS is still
//    keyed on `org_id` alone (a project is an organizational grouping within
//    an org, not its own security boundary), and each of those three tables
//    still exposes `UNIQUE (id, org_id)` so `jobs`/`transcript_segments` can
//    composite-FK down to it the same way apps/api's tables do.
//  * `projects` (added after Phase 5; the plan's original §3 had no such
//    table) is the one exception to "no parent table" below — it groups an
//    org's videos, templates, and renders into the units `apps/stepcut`'s
//    Home screen lists/creates. `transcript_segments`/`jobs`/`steps`/
//    `render_steps` stay scoped through their existing video/render parent
//    rather than getting their own `project_id` — that would duplicate a fact
//    already reachable through the parent, for tables that are never listed
//    by project directly.

import { relations } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
  foreignKey,
  index,
  integer,
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
// Projects — groups an org's videos, templates, and renders into the units
// `apps/stepcut`'s Home screen lists and creates. See this file's header for
// why this table carries no RLS policy of its own beyond the standard
// org-scoped one.
// ---------------------------------------------------------------------------

export const projects = pgTable(
  "projects",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The composite-FK target `videos`/`templates`/`renders` point at below,
    // same pattern `uq_videos_id_org` establishes for `videos`' own children.
    unique("uq_projects_id_org").on(t.id, t.orgId),
    index("idx_projects_org_id").on(t.orgId),
  ],
);

// ---------------------------------------------------------------------------
// Videos, transcripts, jobs — Phase 2 (docs/stepcut-plan.md §8)
// ---------------------------------------------------------------------------
//
// Same shape as apps/api's `videos`/`transcript_segments`/`jobs` (the
// upload/extract/transcribe problem is identical), reimplemented as
// StepCut's own copy — a fresh set of tables, never a shared row. See this
// file's header for the deltas from that reference.

/**
 * A source video. `duration` stays nullable until `extract` probes it, same
 * as apps/api's copy.
 */
export const videos = pgTable(
  "videos",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    projectId: text("project_id").notNull(),
    // The object key `stepcut/{org_id}/{video_id}/{filename}` — a key, never
    // a URL and never a bucket hostname (see src/storage.ts).
    storageKey: text("storage_key").notNull(),
    // 'pending' | 'uploaded' | 'failed'. A row exists from the moment its
    // presigned PUT is minted, so a browser that dies mid-upload leaves a
    // `pending` row to garbage-collect rather than a silent gap.
    uploadStatus: text("upload_status").notNull().default("pending"),
    duration: doublePrecision("duration"),
    // 'pending' | 'audio_ready' | 'transcribed' | 'error'.
    transcriptStatus: text("transcript_status").notNull().default("pending"),
    // SHA-256 of the source bytes, keying the (per-org) transcript/audio
    // cache — the org-first index below, plus RLS, is what keeps it per-org.
    contentHash: text("content_hash"),
    // The cached-audio object key. Set once `extract` succeeds, so a retry
    // can skip straight to transcription.
    audioKey: text("audio_key"),
    // Size of the source object, recorded when the upload completes.
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The composite-FK target for `transcript_segments` and `jobs` below.
    unique("uq_videos_id_org").on(t.id, t.orgId),
    foreignKey({
      name: "fk_videos_project",
      columns: [t.projectId, t.orgId],
      foreignColumns: [projects.id, projects.orgId],
    }).onDelete("cascade"),
    index("idx_videos_org_id").on(t.orgId),
    index("idx_videos_project_id").on(t.projectId),
    // Per-org content-hash lookup, not unique — the same duplicate-import
    // case apps/api's copy documents (importing the same recording twice is
    // ordinary, and the cache finds a sibling by hash, not by uniqueness).
    index("idx_videos_org_content_hash").on(t.orgId, t.contentHash),
  ],
);

/**
 * `id, org_id, video_id, start, end, text` — exactly the plan's §3 listing,
 * nothing more. No `keep` column: dead-air trimming is a lesson-analysis
 * feature StepCut's transcript→steps pipeline doesn't need, so there is no
 * transcript-editing route either.
 */
export const transcriptSegments = pgTable(
  "transcript_segments",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    videoId: text("video_id").notNull(),
    start: doublePrecision("start").notNull(),
    // `end` is a reserved word in Postgres; Drizzle quotes identifiers, so
    // the column really is named `end`.
    end: doublePrecision("end").notNull(),
    text: text("text").notNull(),
  },
  (t) => [
    foreignKey({
      name: "fk_transcript_segments_video",
      columns: [t.videoId, t.orgId],
      foreignColumns: [videos.id, videos.orgId],
    }).onDelete("cascade"),
    index("idx_transcript_segments_video_id").on(t.videoId),
  ],
);

/**
 * The tenant-visible projection of a queued pipeline job — what a future
 * poll/progress surface reads and what a retry acts on.
 * `graphile-worker` brings its own tables in its own schema and owns
 * scheduling/retries/locking; this row is kept separate from that so a job
 * stays tenant-scoped and RLS-covered while the queue's internals are not.
 *
 * `kind` is `'extract' | 'transcribe' | 'analyze' | 'render'` — Phase 5
 * (this slice) adds `'render'` and the nullable `renderId` column below,
 * mirroring `videoId`'s composite-FK-down shape exactly: a render job points
 * at a render the same way a pipeline job points at a video.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    // 'extract' | 'transcribe' | 'analyze' | 'render'.
    kind: text("kind").notNull(),
    // 'queued' | 'running' | 'done' | 'failed' | 'cancelled'.
    state: text("state").notNull().default("queued"),
    videoId: text("video_id"),
    // Set only for a `'render'` job — mirrors `videoId`, mutually exclusive
    // with it in practice (a job is either a video-pipeline stage or a
    // render), but nothing enforces that at the schema level.
    renderId: text("render_id"),
    // Stamped onto the row for a Retry — 1 for a fresh import, higher for a
    // retry of the same stage.
    attempt: integer("attempt").notNull().default(1),
    // null means indeterminate.
    progress: doublePrecision("progress"),
    // Free text shown beside a progress bar ("chunk 3 of 11").
    detail: text("detail"),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "fk_jobs_video",
      columns: [t.videoId, t.orgId],
      foreignColumns: [videos.id, videos.orgId],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_jobs_render",
      columns: [t.renderId, t.orgId],
      foreignColumns: [renders.id, renders.orgId],
    }).onDelete("cascade"),
    index("idx_jobs_video_id").on(t.videoId),
    index("idx_jobs_org_state").on(t.orgId, t.state),
  ],
);

// ---------------------------------------------------------------------------
// Steps — Phase 3 (docs/stepcut-plan.md §8: "AI step proposal")
// ---------------------------------------------------------------------------
//
// What coursecut calls a "lesson," named for what it actually is here: one
// contiguous action in a narrated screen recording, not a topic. Unlike
// `lessons`, a step has exactly one `start`/`end` range of its own — there is
// no `lesson_segments`-style child table, because a step is not assembled
// from possibly-discontiguous ranges the way a lesson can be. No `kind`
// column either: lessons distinguish "lesson" from "qna"/"discussion"/etc.,
// but every step is the same kind of thing.
//
// `source` mirrors `lessons.source` exactly: `analyze` only ever replaces the
// `'ai'` rows (see `apps/stepcut-worker/src/tasks/video.ts`'s `replaceAiSteps`),
// so a step a human has edited survives a re-analysis. Phase 3 never writes
// `source = 'manual'` itself — that arrives with the editor in Phase 4 — but
// the column exists now so `analyze`'s replace-only-'ai' rule has something to
// respect from day one.
export const steps = pgTable(
  "steps",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    videoId: text("video_id").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    start: doublePrecision("start").notNull(),
    end: doublePrecision("end").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    // 'ai' | 'manual'.
    source: text("source").notNull().default("ai"),
    // Nullable — only ever set for an AI-proposed step.
    confidence: doublePrecision("confidence"),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "fk_steps_video",
      columns: [t.videoId, t.orgId],
      foreignColumns: [videos.id, videos.orgId],
    }).onDelete("cascade"),
    index("idx_steps_video_id").on(t.videoId),
  ],
);

// ---------------------------------------------------------------------------
// Templates — Phase 5 (docs/stepcut-plan.md §8: "Templates & render"), slice 1
// ---------------------------------------------------------------------------
//
// An org's reusable render config: brand colors and target output dimensions,
// plus optional intro/outro/logo assets uploaded the same presigned-PUT way a
// video is (see `storage.ts`'s `templateAssetKey`). Belongs to a project —
// each project keeps its own brand kit — and has no relation to `steps`/
// `videos` of its own; `renders` is what composite-FKs down to a template,
// which is the other reason for the `uq_templates_id_org` unique pair below.
export const templates = pgTable(
  "templates",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    // Set only once its `/assets/:kind/complete` call lands — null until then,
    // which is fine, since a template's existence doesn't depend on having
    // assets (unlike a video, there is no upload-in-progress state to track).
    introKey: text("intro_key"),
    outroKey: text("outro_key"),
    logoKey: text("logo_key"),
    brandPrimaryHex: text("brand_primary_hex"),
    brandSecondaryHex: text("brand_secondary_hex"),
    targetWidth: integer("target_width").notNull().default(1920),
    targetHeight: integer("target_height").notNull().default(1080),
    targetFps: integer("target_fps").notNull().default(30),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The composite-FK target `renders` points at, same pattern
    // `uq_videos_id_org` establishes for `videos`.
    unique("uq_templates_id_org").on(t.id, t.orgId),
    foreignKey({
      name: "fk_templates_project",
      columns: [t.projectId, t.orgId],
      foreignColumns: [projects.id, projects.orgId],
    }).onDelete("cascade"),
    index("idx_templates_org_id").on(t.orgId),
    index("idx_templates_project_id").on(t.projectId),
  ],
);

// ---------------------------------------------------------------------------
// Renders — Phase 5 (docs/stepcut-plan.md §8: "Templates & render"), this
// slice
// ---------------------------------------------------------------------------
//
// `POST /renders` snapshots a video's *current* `steps` into `render_steps`
// at the moment it is called (plan §4/§5 step 5) — editing a step afterward
// must not change what a render already in flight produces. `renders` is the
// tenant-visible status row a poller reads; the worker task that actually
// cuts/assembles video (Phase 5's next slice) is the only thing that ever
// moves `status` past `'queued'`/`'cancelled'`.
//
// No pause/resume, unlike apps/api's `exports`: a render has exactly one
// non-terminal transition a caller can request — cancel (see
// `domain/renders.ts`'s `cancelRender`).
export const renders = pgTable(
  "renders",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    // Denormalized off `videoId`/`templateId` (both required to already agree
    // on it — `domain/renders.ts`'s `createRender` checks that before insert)
    // — carried directly, like `orgId`, so `GET /projects/:id/renders` is a
    // single-column filter rather than a join.
    projectId: text("project_id").notNull(),
    videoId: text("video_id").notNull(),
    templateId: text("template_id").notNull(),
    // 'queued' | 'running' | 'done' | 'failed' | 'cancelled'.
    status: text("status").notNull().default("queued"),
    // null until the worker reports something better than "queued" — same
    // "null means indeterminate" convention `jobs.progress` uses.
    progress: doublePrecision("progress"),
    // Set once the worker's assembled output lands in storage.
    outputKey: text("output_key"),
    error: text("error"),
    // Validated at creation time (`domain/renders.ts`'s
    // `isPrivateOrLoopbackHost`) — see that file for why an unchecked
    // caller-supplied URL here would be an SSRF path into the droplet's own
    // internal services.
    callbackUrl: text("callback_url"),
    // Recorded once the finished output is known, for the download surface.
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    downloadExpiresAt: timestamp("download_expires_at", { withTimezone: true }),
    // 'pending' | 'delivered' | 'failed' — set once a `callback_url` exists
    // and the worker has attempted delivery. Null when there is no callback
    // to deliver.
    webhookStatus: text("webhook_status"),
    webhookAttempts: integer("webhook_attempts").notNull().default(0),
    webhookLastError: text("webhook_last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // A render can't outlive its source video.
    foreignKey({
      name: "fk_renders_video",
      columns: [t.videoId, t.orgId],
      foreignColumns: [videos.id, videos.orgId],
    }).onDelete("cascade"),
    // A render with no template to reference is meaningless — same reasoning
    // as the video FK above.
    foreignKey({
      name: "fk_renders_template",
      columns: [t.templateId, t.orgId],
      foreignColumns: [templates.id, templates.orgId],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_renders_project",
      columns: [t.projectId, t.orgId],
      foreignColumns: [projects.id, projects.orgId],
    }).onDelete("cascade"),
    // The composite-FK target `render_steps`/`jobs` point at.
    unique("uq_renders_id_org").on(t.id, t.orgId),
    index("idx_renders_org_id").on(t.orgId),
    index("idx_renders_project_id").on(t.projectId),
    // `GET /videos/:id/renders`'s own lookup.
    index("idx_renders_video_id").on(t.videoId),
  ],
);

/**
 * A SNAPSHOT of one step at the moment `POST /renders` was called — see this
 * file's `renders` comment. Cut/Assemble (Phase 5's worker task) reads only
 * this table, never `steps` directly.
 *
 * `stepId` is nullable and traceability-only, unlike `renderId`: deleting the
 * live `steps` row a render_step was snapshotted from must not touch the
 * snapshot, so it is `onDelete: "set null"` rather than the composite,
 * cascading FK `renderId` gets.
 */
export const renderSteps = pgTable(
  "render_steps",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    renderId: text("render_id").notNull(),
    stepId: text("step_id").references(() => steps.id, { onDelete: "set null" }),
    sortOrder: integer("sort_order").notNull(),
    start: doublePrecision("start").notNull(),
    end: doublePrecision("end").notNull(),
    title: text("title").notNull(),
  },
  (t) => [
    foreignKey({
      name: "fk_render_steps_render",
      columns: [t.renderId, t.orgId],
      foreignColumns: [renders.id, renders.orgId],
    }).onDelete("cascade"),
    index("idx_render_steps_render_id").on(t.renderId),
  ],
);

// ---------------------------------------------------------------------------
// Relations — for Drizzle's query API; no effect on the generated DDL.
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

export const projectsRelations = relations(projects, ({ many }) => ({
  videos: many(videos),
  templates: many(templates),
  renders: many(renders),
}));

export const videosRelations = relations(videos, ({ one, many }) => ({
  project: one(projects, { fields: [videos.projectId], references: [projects.id] }),
  transcriptSegments: many(transcriptSegments),
  jobs: many(jobs),
  steps: many(steps),
  renders: many(renders),
}));

export const transcriptSegmentsRelations = relations(transcriptSegments, ({ one }) => ({
  video: one(videos, { fields: [transcriptSegments.videoId], references: [videos.id] }),
}));

export const jobsRelations = relations(jobs, ({ one }) => ({
  video: one(videos, { fields: [jobs.videoId], references: [videos.id] }),
  render: one(renders, { fields: [jobs.renderId], references: [renders.id] }),
}));

export const stepsRelations = relations(steps, ({ one }) => ({
  video: one(videos, { fields: [steps.videoId], references: [videos.id] }),
}));

export const templatesRelations = relations(templates, ({ one }) => ({
  project: one(projects, { fields: [templates.projectId], references: [projects.id] }),
}));

// `renders`/`render_steps` — this slice. `render_steps` is structurally the
// same shape as `steps` (a child row FK'd to one parent), so it gets a
// `one()` back the same way `stepsRelations` does; `renders` additionally
// gets a `one()` to its template, since (unlike `videos`) nothing else here
// composite-FKs to `templates` yet, so there is no reciprocal `many()` to add
// on that side.
export const rendersRelations = relations(renders, ({ one, many }) => ({
  project: one(projects, { fields: [renders.projectId], references: [projects.id] }),
  video: one(videos, { fields: [renders.videoId], references: [videos.id] }),
  template: one(templates, { fields: [renders.templateId], references: [templates.id] }),
  renderSteps: many(renderSteps),
}));

export const renderStepsRelations = relations(renderSteps, ({ one }) => ({
  render: one(renders, { fields: [renderSteps.renderId], references: [renders.id] }),
  step: one(steps, { fields: [renderSteps.stepId], references: [steps.id] }),
}));

/**
 * The tables RLS must cover — every table holding tenant data that is looked
 * up *after* the caller's org is already known. Phase 2 changes this from
 * empty to `videos`/`transcript_segments`/`jobs`:
 *
 *   * `api_keys` is still deliberately **not** in this list even though it is
 *     tenant data. Verifying a bearer key means finding its row by
 *     `key_hash` *before* any org is known — the same chicken-and-egg
 *     problem that keeps `users`/`sessions` out of RLS above: RLS keyed on
 *     `app.current_org_id` can only filter once the org is already set, not
 *     discover it. So `api_keys` sits alongside the auth tables: a plain
 *     `org_id` FK, no policy, looked up directly by the (future)
 *     `requireApiKey` middleware, which then calls `withOrg(row.orgId, ...)`
 *     for everything downstream of that lookup.
 */
export const TENANT_TABLES = [
  "projects",
  "videos",
  "transcript_segments",
  "jobs",
  "steps",
  "templates",
  "renders",
  "render_steps",
] as const;
