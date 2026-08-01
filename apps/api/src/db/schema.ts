// The web app's Postgres schema — the six desktop SQLite migrations
// (`src-tauri/migrations/0001_init` … `0006_lesson_segments`) ported forward,
// plus the additions multi-tenancy forces (docs/web-app-plan.md §6).
//
// Two rules govern every choice here:
//
//  1. **Column names carry over from desktop** wherever the concept is the
//     same, so the TS types in `apps/web/src/db.ts` stay identical to the
//     desktop app's and the copied views compile untouched. Where the plan
//     renames a column (`file_path` → `storage_key`, `output_path` →
//     `output_key`), the API maps back to the desktop name on the wire; the
//     rename is a storage-model fact, not a UI one.
//
//  2. **Every tenant-scoped row carries `org_id` directly**, so an RLS policy
//     is a single-column check rather than a join back up to `projects`.
//     Denormalization like that normally invites drift between a child's
//     `org_id` and its parent's — so it is nailed shut with composite foreign
//     keys: each table has a `UNIQUE (id, org_id)` and children reference
//     `(parent_id, org_id)`. Postgres then makes a mismatched pair
//     unrepresentable rather than merely discouraged.
//
// Conventions that differ from desktop, deliberately:
//
//  * Ids are `text`, not `uuid`. `better-auth` mints its own ids and they are
//    not UUIDs, and desktop already treats ids as opaque TEXT everywhere
//    (see 0006's backfill note). Uniform `text` keeps `id: string` honest on
//    both sides. Plan §6 says `::uuid`; this is the correction.
//  * `created_at`/`updated_at` are `timestamptz`, not ISO-8601 TEXT. Desktop
//    stores strings because SQLite has no date type; Postgres does. The API
//    serializes them back to ISO strings, so `db.ts` still sees `string`.
//  * Second-offsets (`start`, `end`, `duration`, `confidence`, `progress`)
//    stay floating point, matching desktop's REAL.

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

// Shorthands for the three column shapes that repeat on nearly every table.
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
// M3 did that reconciliation (`npm run auth:generate` — the generator, not
// this file, is the authority on these seven tables) and the mapping turned
// out to need one knob, configured in `src/auth.ts`:
//
//     usePlural: true      user → users, session → sessions, … all seven
//
// and **no column mapping at all**, because the Drizzle adapter addresses
// columns by each table's JavaScript property name, which is already the
// camelCase name `better-auth` uses (`userId`, `expiresAt`,
// `activeOrganizationId`). The snake_case below is the SQL name Drizzle
// emits, and the adapter never sees it.
//
// Three deliberate differences from the generated output, all additive:
//
//   * `timestamptz` rather than naked `timestamp`, matching the convention
//     the rest of this file follows. The library reads and writes `Date`.
//   * `defaultNow()` on `organizations.created_at` / `members.created_at`,
//     which the generator leaves defaulted-in-code only.
//   * Two extra UNIQUE constraints — `uq_members_org_user` and
//     `uq_accounts_provider_account` — for invariants the app relies on (one
//     membership per user per org; one account per provider identity) that
//     the generator states in code rather than in the schema.
//
// None of them carry RLS. They are not tenant-scoped data: sign-in has to
// find a user by email before any org context exists, and the org switcher
// has to list a user's memberships before one is active. Scoping here is
// `better-auth`'s job, done per-user against the session — see
// `0001_rls.sql`'s header for why that split is the safe one.

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
    // This is the value `apps/api` will feed to `app.current_org_id` on every
    // request, after checking the session actually has a membership in it.
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
    // Hashed by `better-auth`, never by us — plan §7 is explicit that the
    // library's defaults beat hand-rolled crypto here.
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

/** The tenant. Everything below hangs off this by `org_id`. */
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
    // "owner" | "admin" | "member" — `better-auth`'s vocabulary. Plan §4.1
    // starts us on owner/member; leaving the column unconstrained means
    // adopting the third costs no migration.
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
// Domain — ported from the desktop migrations
// ---------------------------------------------------------------------------

/** Desktop `projects` (0001) + `org_id`. */
export const projects = pgTable(
  "projects",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The composite-FK target for `videos`.
    //
    // A UNIQUE *constraint* rather than a unique index, and that matters:
    // drizzle-kit emits constraints inline in CREATE TABLE but indexes after
    // the ALTER TABLE … ADD FOREIGN KEY block, and a composite FK cannot
    // reference columns that are not yet unique. As an index this migration
    // does not apply at all. Same for the three below.
    unique("uq_projects_id_org").on(t.id, t.orgId),
    index("idx_projects_org_id").on(t.orgId),
  ],
);

/**
 * Desktop `videos` (0001 + 0002's cache columns), with the file replaced by
 * an object key. `duration` stays nullable — it is unknown until the upload
 * completes and the API probes the file.
 */
export const videos = pgTable(
  "videos",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    projectId: text("project_id").notNull(),
    // D2 / plan §3.4 rule 1: the R2 object key
    // `{org_id}/{project_id}/{video_id}/{filename}` — a key, never a URL and
    // never a bucket hostname. Surfaced to the SPA as `file_path` so
    // `basename()` still renders the name the user uploaded.
    storageKey: text("storage_key").notNull(),
    // The upload step desktop never had (plan §6). A row exists from the
    // moment its presigned PUT is minted, so a browser that dies mid-upload
    // leaves a `pending` row to garbage-collect rather than a silent gap.
    // 'pending' | 'uploaded' | 'failed'.
    uploadStatus: text("upload_status").notNull().default("pending"),
    duration: doublePrecision("duration"),
    // 'pending' | 'audio_ready' | 'transcribed' | 'error' — desktop's actual
    // vocabulary (`src-tauri/src/ffmpeg.rs` and `openai.rs` are the only
    // writers; `PRE_TRANSCRIPT_STATUSES` in `ProjectDetailView` is the only
    // reader that branches on it). Unconstrained, as there.
    transcriptStatus: text("transcript_status").notNull().default("pending"),
    // Desktop 0002: SHA-256 of the source bytes, keying the transcript cache.
    // Plan §6 makes that cache **per-org** — a security requirement, since a
    // shared cache would tell one tenant that another holds the same video.
    // The org-first index below, plus RLS, is what enforces it.
    contentHash: text("content_hash"),
    // Desktop 0002's cached-WAV path, as an object key. Set once the extract
    // job succeeds, so a retry can skip straight to transcription.
    audioKey: text("audio_key"),
    // M7. Size of the source object, recorded when the upload completes (from
    // the `HeadObject` the completion already does — no extra call). This is
    // the storage meter: summing a column is a millisecond, and listing a
    // tenant's bucket prefix on every upload request would not be. The
    // retention sweep reconciles the two.
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "fk_videos_project",
      columns: [t.projectId, t.orgId],
      foreignColumns: [projects.id, projects.orgId],
    }).onDelete("cascade"),
    unique("uq_videos_id_org").on(t.id, t.orgId),
    index("idx_videos_project_id").on(t.projectId),
    // Per-org content-hash lookup: org-first, so it can never match across
    // orgs, which is the security half of plan §6's per-org cache rule (RLS
    // is the other half — a query inside `withOrg` cannot see a foreign row
    // whatever this index says).
    //
    // **Not unique**, and that is a correction to M2 rather than an omission.
    // The unique version assumed at most one row per content per org, which
    // made a perfectly ordinary act — importing the same lecture twice —
    // impossible to record: the second video's extract job could not write
    // its own hash. Desktop has always allowed duplicate hashes, because
    // duplicate rows sharing a hash is exactly how its cache *finds*
    // anything (`WHERE content_hash = ?1 AND audio_path IS NOT NULL`). See
    // `drizzle/0002_video_content_hash_not_unique.sql`.
    index("idx_videos_org_content_hash").on(t.orgId, t.contentHash),
  ],
);

/** Desktop `transcript_segments` (0001). `keep` becomes a real boolean. */
export const transcriptSegments = pgTable(
  "transcript_segments",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    videoId: text("video_id").notNull(),
    start: doublePrecision("start").notNull(),
    // `end` is a reserved word in Postgres. Drizzle quotes identifiers, so
    // the column really is named `end` — keeping the desktop name, and the
    // `TranscriptSegment.end` field in `db.ts`, exactly as they are.
    end: doublePrecision("end").notNull(),
    text: text("text").notNull(),
    keep: boolean("keep").notNull().default(true),
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

/** Desktop `lessons` (0001 + 0003's AI columns). */
export const lessons = pgTable(
  "lessons",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    videoId: text("video_id").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    // Since 0006 these are a *cached derived bound* — min/max across the
    // lesson's segments — recomputed after every segment write, not a
    // lesson's own range and not maintained by a trigger. Same contract as
    // desktop's `recompute_lesson_bounds_tx`; `apps/api` owns it here.
    start: doublePrecision("start").notNull(),
    end: doublePrecision("end").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    // 0003: nullable, because a manually-created lesson never saw the model.
    confidence: doublePrecision("confidence"),
    // 'lesson' | 'qna' | 'discussion' | 'break' | 'silence' | 'duplicate'.
    kind: text("kind").notNull().default("lesson"),
    // 'ai' | 'manual'. Re-running analysis replaces only the 'ai' rows, which
    // is the whole reason this column exists.
    source: text("source").notNull().default("ai"),
  },
  (t) => [
    foreignKey({
      name: "fk_lessons_video",
      columns: [t.videoId, t.orgId],
      foreignColumns: [videos.id, videos.orgId],
    }).onDelete("cascade"),
    unique("uq_lessons_id_org").on(t.id, t.orgId),
    index("idx_lessons_video_id").on(t.videoId),
  ],
);

/**
 * Desktop `lesson_segments` (0006). No overlap constraint anywhere —
 * segment-vs-segment within a lesson or lesson-vs-lesson — matching desktop
 * deliberately.
 */
export const lessonSegments = pgTable(
  "lesson_segments",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    lessonId: text("lesson_id").notNull(),
    start: doublePrecision("start").notNull(),
    end: doublePrecision("end").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [
    foreignKey({
      name: "fk_lesson_segments_lesson",
      columns: [t.lessonId, t.orgId],
      foreignColumns: [lessons.id, lessons.orgId],
    }).onDelete("cascade"),
    index("idx_lesson_segments_lesson_id").on(t.lessonId),
  ],
);

/** Desktop `exports` (0001 + 0005's queue columns), writing to R2 not a folder. */
export const exports = pgTable(
  "exports",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    lessonId: text("lesson_id").notNull(),
    // D5: the output object key. Computed when the job is queued (it is
    // derived from ids, not from anything ffmpeg produces), so it can be
    // NOT NULL exactly as desktop's `output_path` was.
    outputKey: text("output_key").notNull(),
    // 'queued' | 'paused' | 'running' | 'done' | 'failed' | 'cancelled'.
    status: text("status").notNull().default("queued"),
    // 0005: fraction in [0,1] of the lesson's own duration.
    progress: doublePrecision("progress").notNull().default(0),
    // 0005: only ever set when status = 'failed'.
    error: text("error"),
    // Plan §6. The download URL is minted on demand and short-lived; this
    // records when the *object* stops being available, so Export History can
    // grey out a row whose file has aged out instead of handing the user a
    // link to a 404.
    //
    // M7 is what finally writes it: the worker stamps it when the encode
    // succeeds, and the retention sweep deletes the object once it passes and
    // moves the row to `expired`. Before M7 nothing set it and nothing aged
    // out, which is exactly the unbounded-storage problem quotas exist for.
    downloadExpiresAt: timestamp("download_expires_at", { withTimezone: true }),
    // M7. Size of the finished MP4, for the same storage meter as
    // `videos.size_bytes`. Null until the encode uploads something.
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "fk_exports_lesson",
      columns: [t.lessonId, t.orgId],
      foreignColumns: [lessons.id, lessons.orgId],
    }).onDelete("cascade"),
    // The composite-FK target for a `jobs` row of kind 'export'.
    unique("uq_exports_id_org").on(t.id, t.orgId),
    index("idx_exports_lesson_id").on(t.lessonId),
    index("idx_exports_org_created").on(t.orgId, t.createdAt),
  ],
);

/**
 * Our own job row (plan §6). `graphile-worker` brings its own tables in its
 * own schema at M5 and owns scheduling, retries and locking; this is the
 * user-visible projection of a job — what the SSE progress stream reads from
 * and what a Retry button acts on. Keeping them separate means the queue
 * stays swappable and, more immediately, that a job is tenant-scoped and
 * RLS-covered while `graphile_worker`'s internals are not.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    // 'extract' | 'transcribe' | 'analyze' | 'export'.
    kind: text("kind").notNull(),
    // 'queued' | 'running' | 'done' | 'failed' | 'cancelled'.
    state: text("state").notNull().default("queued"),
    // Set for extract/transcribe/analyze; null for an export job.
    videoId: text("video_id"),
    // Set for export jobs; null otherwise.
    exportId: text("export_id"),
    // Stamped onto every progress event this run emits — 1 for a fresh
    // import, >1 for a Retry. Same convention as desktop's `attempt`, which
    // `VideoProgress` already carries.
    attempt: integer("attempt").notNull().default(1),
    // null means indeterminate: `useVideoProgress` shows a spinner, not a bar.
    progress: doublePrecision("progress"),
    // Free text shown beside the bar ("chunk 3 of 11").
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
      name: "fk_jobs_export",
      columns: [t.exportId, t.orgId],
      foreignColumns: [exports.id, exports.orgId],
    }).onDelete("cascade"),
    index("idx_jobs_video_id").on(t.videoId),
    index("idx_jobs_org_state").on(t.orgId, t.state),
  ],
);

/**
 * Desktop's `app_settings` (0004), per org.
 *
 * There is deliberately **no OpenAI key column here** (D7). The web app uses
 * a single platform-owned key held in the server's environment — orgs do not
 * bring their own, are never asked for one, and no key of any kind is stored
 * in this database. A column that does not exist cannot leak, so this is the
 * cheapest possible version of that guarantee.
 *
 * The consequence is that API spend is ours, not the tenant's, which makes
 * per-org quotas and cost caps (M7) load-bearing rather than a nicety — see
 * plan §9. This table is where those limits will land.
 */
export const orgSettings = pgTable("org_settings", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  // 0004's free-text analysis preferences, appended to the GPT-5.5 prompt.
  // Still user-editable per org — the model's instructions are the tenant's
  // to set even though the key is not.
  analysisInstructions: text("analysis_instructions"),

  // --- M7: limits, all nullable overrides of the platform default ---
  //
  // Null means "whatever `env.ts` says", so raising every tenant's ceiling is
  // a deploy variable and lifting one tenant's is a single UPDATE. A zero is
  // a real value and means zero, which is how an org is throttled without
  // being suspended.
  //
  // These are **not** user-editable. Unlike `analysis_instructions` they are
  // the platform's side of the bargain, and `routes/settings.ts` never writes
  // them — the only writer is an operator with psql.
  /** Minutes of audio that may be sent to Whisper per calendar month. */
  transcriptionMinutesLimit: integer("transcription_minutes_limit"),
  /** Ceiling on `sum(videos.size_bytes) + sum(exports.size_bytes)`. */
  storageBytesLimit: bigint("storage_bytes_limit", { mode: "number" }),
  /**
   * Days a source video is kept before the retention sweep purges it, or null
   * for the platform default — which is *off*. Plan §9 says to define a
   * retention window and honour it; the honouring is the sweep, and the
   * default being off is deliberate. Deleting a tenant's uploads on a timer
   * they never asked for is not a default anyone should get by accident, and
   * the thing that actually has to be bounded — cost — is bounded by the
   * quotas above instead.
   */
  retentionDays: integer("retention_days"),

  // --- M7: the abuse kill switch ---
  //
  // Set by an operator, checked by every quota-consuming call. Reads, exports
  // already finished, and deletion all keep working: suspending a tenant must
  // stop them spending our money, not hold their data hostage.
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  suspendedReason: text("suspended_reason"),

  updatedAt: updatedAt(),
});

/**
 * The meter (M7).
 *
 * Append-only. One row per unit of metered work actually performed — today
 * that is `transcription_seconds`, written by the worker when audio is really
 * sent to Whisper (a cache hit writes nothing, because it costs nothing).
 * GPT analysis is not metered separately: its cost is proportional to the
 * transcript, which is proportional to the audio minutes already counted.
 *
 * **No foreign key to `videos`, and that is the point.** A usage row must
 * survive the deletion of the thing it describes, or deleting a video would
 * refund the transcription it already paid for and a tenant at their monthly
 * limit could reset it on demand. `video_id`/`export_id` below are references
 * for support and debugging, not relationships. The one FK that does cascade
 * is the org's: a deleted tenant takes its ledger with it, which is right —
 * there is no longer anyone to bill.
 */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** 'transcription_seconds' — the only kind M7 writes. */
    kind: text("kind").notNull(),
    quantity: doublePrecision("quantity").notNull(),
    /** Ids of what produced it. Deliberately unconstrained (see above). */
    videoId: text("video_id"),
    exportId: text("export_id"),
    detail: text("detail"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The shape every quota check runs: this org, this kind, since the start
    // of the period.
    index("idx_usage_events_org_kind_occurred").on(t.orgId, t.kind, t.occurredAt),
  ],
);

// ---------------------------------------------------------------------------
// Relations — for Drizzle's query API; no effect on the generated DDL.
// ---------------------------------------------------------------------------

export const organizationsRelations = relations(organizations, ({ many, one }) => ({
  members: many(members),
  projects: many(projects),
  settings: one(orgSettings),
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

export const projectsRelations = relations(projects, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [projects.orgId],
    references: [organizations.id],
  }),
  videos: many(videos),
}));

export const videosRelations = relations(videos, ({ one, many }) => ({
  project: one(projects, { fields: [videos.projectId], references: [projects.id] }),
  transcriptSegments: many(transcriptSegments),
  lessons: many(lessons),
}));

export const transcriptSegmentsRelations = relations(transcriptSegments, ({ one }) => ({
  video: one(videos, { fields: [transcriptSegments.videoId], references: [videos.id] }),
}));

export const lessonsRelations = relations(lessons, ({ one, many }) => ({
  video: one(videos, { fields: [lessons.videoId], references: [videos.id] }),
  segments: many(lessonSegments),
  exports: many(exports),
}));

export const lessonSegmentsRelations = relations(lessonSegments, ({ one }) => ({
  lesson: one(lessons, { fields: [lessonSegments.lessonId], references: [lessons.id] }),
}));

export const exportsRelations = relations(exports, ({ one }) => ({
  lesson: one(lessons, { fields: [exports.lessonId], references: [lessons.id] }),
}));

/**
 * The tables RLS must cover — every table holding tenant data. The RLS
 * migration and the isolation test both read this list, so a new tenant table
 * that forgets its policy fails the test rather than shipping unprotected.
 */
export const TENANT_TABLES = [
  "projects",
  "videos",
  "transcript_segments",
  "lessons",
  "lesson_segments",
  "exports",
  "jobs",
  "org_settings",
  "usage_events",
] as const;
