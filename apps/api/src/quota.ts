// Per-org quotas and cost caps (M7).
//
// **Why this file exists at all.** On desktop the user brings their own OpenAI
// key, so transcription spend is theirs and unbounded upload is bounded by
// their own disk. D7 made the key ours, which moves both onto us: every minute
// of audio a tenant uploads is a Whisper bill we pay and a worker core we own.
// Plan §4 is explicit that this makes quotas "load-bearing rather than a
// hardening nicety — they gate the first untrusted signup". This is that gate,
// and it is why the plan's own advice was to stay invite-only until it existed.
//
// **What is metered, and what is not.**
//
//   transcription minutes   per calendar month, from `usage_events`. The one
//                           thing that costs money per unit of use. GPT
//                           analysis is not metered separately: its cost is
//                           proportional to the transcript, which is
//                           proportional to the audio minutes already counted,
//                           so a second meter would track the first one.
//   stored bytes            a level, not a flow — `sum(videos.size_bytes) +
//                           sum(exports.size_bytes)`. Deleting a project frees
//                           it, which is the behaviour a user expects from
//                           something called "storage used".
//   active jobs             not a cost, a fairness limit. One worker at
//                           concurrency 1 (plan §3.3) means one tenant with a
//                           thousand queued exports is an outage for everyone
//                           else.
//
// **Where the checks go.** At the point work is *requested*, not where it
// runs: an upload ticket, a pipeline enqueue, an export queue. That is the only
// place a refusal can be a sentence the user reads — a worker refusing a job it
// already accepted is a failed row and a support ticket. The worker re-checks
// the transcription quota anyway, because the enqueue check is minutes or hours
// stale by the time Whisper is actually called.
//
// **Everything here reads through the caller's `Tx`**, so a quota check is
// itself tenant-scoped by RLS. There is deliberately no cross-org query in this
// file; totals for an operator come from psql as the admin role.

import { and, eq, gte, sql } from "drizzle-orm";
import type { Tx } from "./db/client.js";
import { env } from "./env.js";
import { exports as exportsTable, jobs, orgSettings, usageEvents, videos } from "./db/schema.js";
import { httpError } from "./http/errors.js";
import { newId } from "./domain/lessons.js";

/** The only metered kind M7 writes. See this file's header. */
export const TRANSCRIPTION_SECONDS = "transcription_seconds";

export interface OrgLimits {
  transcriptionMinutesPerMonth: number;
  storageBytes: number;
  maxUploadBytes: number;
  maxActiveJobs: number;
  /** 0 = source video never expires. */
  retentionDays: number;
  suspendedAt: Date | null;
  suspendedReason: string | null;
}

export interface OrgUsage {
  /** Start of the current calendar month, UTC — what "this month" means. */
  periodStart: string;
  transcriptionMinutes: number;
  storageBytes: number;
  activeJobs: number;
}

/**
 * 402, not 429.
 *
 * A quota refusal is not "slow down and retry" — retrying next second gets the
 * same answer, and a client that treats it as a rate limit will hammer it. 402
 * says the request was understood and refused on account of the account, which
 * is exactly what happened. The message is what the copied views render, so it
 * says what ran out and what to do, not "quota exceeded".
 */
export function quotaExceeded(message: string) {
  return httpError(402, message);
}

// ---------------------------------------------------------------------------
// Reading limits and usage
// ---------------------------------------------------------------------------

/**
 * This org's limits: the platform defaults from `env.ts`, with any non-null
 * `org_settings` column overriding.
 *
 * `??` rather than `||`, deliberately: a limit of 0 is a real, meaningful
 * value — it is how a tenant is throttled to nothing without being suspended —
 * and `||` would silently promote it back to the default.
 */
export async function limitsFor(tx: Tx, orgId: string): Promise<OrgLimits> {
  const [row] = await tx
    .select({
      transcriptionMinutesLimit: orgSettings.transcriptionMinutesLimit,
      storageBytesLimit: orgSettings.storageBytesLimit,
      retentionDays: orgSettings.retentionDays,
      suspendedAt: orgSettings.suspendedAt,
      suspendedReason: orgSettings.suspendedReason,
    })
    .from(orgSettings)
    .where(eq(orgSettings.orgId, orgId))
    .limit(1);

  return {
    transcriptionMinutesPerMonth:
      row?.transcriptionMinutesLimit ?? env.quotaTranscriptionMinutes(),
    storageBytes: row?.storageBytesLimit ?? env.quotaStorageBytes(),
    maxUploadBytes: env.quotaMaxUploadBytes(),
    maxActiveJobs: env.quotaMaxActiveJobs(),
    retentionDays: row?.retentionDays ?? env.retentionSourceDays(),
    suspendedAt: row?.suspendedAt ?? null,
    suspendedReason: row?.suspendedReason ?? null,
  };
}

/** Start of the current calendar month in UTC. */
export function periodStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Seconds of audio sent to Whisper by this org since the period began. */
export async function transcriptionSecondsUsed(tx: Tx, orgId: string): Promise<number> {
  const [row] = await tx
    .select({ total: sql<number>`coalesce(sum(${usageEvents.quantity}), 0)::double precision` })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.orgId, orgId),
        eq(usageEvents.kind, TRANSCRIPTION_SECONDS),
        gte(usageEvents.occurredAt, periodStart()),
      ),
    );
  return row?.total ?? 0;
}

/**
 * Bytes this org currently occupies: source videos plus finished exports.
 *
 * Extracted audio is not counted. It is Opus at ~16 kB/s — about 1% of the
 * video it came from — and it is not something the user chose to store, so
 * charging it against their ceiling would be noise they cannot act on. The
 * retention sweep still deletes it with everything else.
 */
export async function storageBytesUsed(tx: Tx, orgId: string): Promise<number> {
  const [videoTotal] = await tx
    .select({ total: sql<number>`coalesce(sum(${videos.sizeBytes}), 0)::double precision` })
    .from(videos)
    .where(eq(videos.orgId, orgId));
  const [exportTotal] = await tx
    .select({ total: sql<number>`coalesce(sum(${exportsTable.sizeBytes}), 0)::double precision` })
    .from(exportsTable)
    .where(eq(exportsTable.orgId, orgId));
  return (videoTotal?.total ?? 0) + (exportTotal?.total ?? 0);
}

export async function activeJobCount(tx: Tx, orgId: string): Promise<number> {
  const [row] = await tx
    .select({ total: sql<number>`count(*)::double precision` })
    .from(jobs)
    .where(and(eq(jobs.orgId, orgId), sql`${jobs.state} in ('queued', 'running')`));
  return row?.total ?? 0;
}

/** Everything the Usage dialog shows, in one transaction. */
export async function usageFor(tx: Tx, orgId: string): Promise<OrgUsage> {
  const [seconds, bytes, active] = await Promise.all([
    transcriptionSecondsUsed(tx, orgId),
    storageBytesUsed(tx, orgId),
    activeJobCount(tx, orgId),
  ]);
  return {
    periodStart: periodStart().toISOString(),
    transcriptionMinutes: seconds / 60,
    storageBytes: bytes,
    activeJobs: active,
  };
}

// ---------------------------------------------------------------------------
// Writing usage
// ---------------------------------------------------------------------------

/**
 * Records metered work that actually happened.
 *
 * Called *after* the work, never before: a reservation that is never released
 * (a worker killed mid-transcode) bills a tenant for something they did not
 * get, and the failure mode of counting late — a burst that slightly overshoots
 * the ceiling before the next check sees it — is bounded by the active-job cap
 * and costs one video's worth of overrun at most.
 */
export function recordUsage(
  tx: Tx,
  orgId: string,
  kind: string,
  quantity: number,
  ref: { videoId?: string; exportId?: string; detail?: string } = {},
): Promise<unknown> {
  return tx.insert(usageEvents).values({
    id: newId(),
    orgId,
    kind,
    quantity,
    videoId: ref.videoId ?? null,
    exportId: ref.exportId ?? null,
    detail: ref.detail ?? null,
  });
}

// ---------------------------------------------------------------------------
// The gates
// ---------------------------------------------------------------------------

function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * An org an operator has switched off.
 *
 * Reads, downloads of exports that already finished, and deletion all still
 * work — only the calls that spend money or CPU come through here. Suspension
 * is a cost control, not a way to hold a tenant's data hostage, and a suspended
 * tenant that cannot export or delete what they already have is the latter.
 */
export function assertNotSuspended(limits: OrgLimits): void {
  if (!limits.suspendedAt) return;
  throw quotaExceeded(
    limits.suspendedReason
      ? `This organization is suspended: ${limits.suspendedReason}`
      : "This organization is suspended. Contact support to re-enable it.",
  );
}

/** Upload: file size against the per-file cap, and against the headroom left. */
export async function assertCanUpload(tx: Tx, orgId: string, sizeBytes: number): Promise<void> {
  const limits = await limitsFor(tx, orgId);
  assertNotSuspended(limits);

  if (sizeBytes > limits.maxUploadBytes) {
    throw quotaExceeded(
      `That file is ${formatGb(sizeBytes)}, and the limit for a single upload is ${formatGb(limits.maxUploadBytes)}.`,
    );
  }

  const used = await storageBytesUsed(tx, orgId);
  if (used + sizeBytes > limits.storageBytes) {
    throw quotaExceeded(
      `This organization is using ${formatGb(used)} of its ${formatGb(limits.storageBytes)} of storage, ` +
        `which does not leave room for a ${formatGb(sizeBytes)} file. Delete a project or an old export to free space.`,
    );
  }
}

/**
 * Transcription: refuse when the month's minutes are already spent.
 *
 * Checked at the ceiling rather than against this video's length, because the
 * length is not known until the extract job probes it — the video has not been
 * downloaded yet at the point a browser asks for extraction. So a tenant at 599
 * of 600 minutes can start one more 40-minute lecture and end the month at 639.
 * That overshoot is deliberate and bounded: the alternative is refusing work
 * whose size we are guessing at, and one video's overrun is cheaper than a
 * wrong refusal.
 */
export async function assertCanTranscribe(tx: Tx, orgId: string): Promise<void> {
  const limits = await limitsFor(tx, orgId);
  assertNotSuspended(limits);

  const used = await transcriptionSecondsUsed(tx, orgId);
  if (used / 60 >= limits.transcriptionMinutesPerMonth) {
    throw quotaExceeded(
      `This organization has used all ${limits.transcriptionMinutesPerMonth} of its transcription minutes for this month. ` +
        `The allowance resets at the start of next month.`,
    );
  }
}

/** Fairness, not cost: one tenant cannot fill the single worker's queue. */
export async function assertCanQueueJob(tx: Tx, orgId: string): Promise<void> {
  const limits = await limitsFor(tx, orgId);
  assertNotSuspended(limits);
  await assertActiveJobs(tx, orgId, limits);
}

async function assertActiveJobs(tx: Tx, orgId: string, limits: OrgLimits): Promise<void> {
  const active = await activeJobCount(tx, orgId);
  if (active >= limits.maxActiveJobs) {
    throw quotaExceeded(
      `This organization already has ${active} jobs queued or running, which is the limit. ` +
        `Wait for one to finish, or cancel one, before starting another.`,
    );
  }
}

/**
 * Export: the active-job cap, plus enough storage headroom for the output.
 *
 * The output's size is unknown until it is encoded, so headroom is checked
 * against the remaining allowance being non-zero rather than against a guess.
 * A tenant at their ceiling cannot start an export that would push them
 * further past it; one with room gets the same overshoot allowance as an
 * upload, for the same reason.
 */
export async function assertCanExport(tx: Tx, orgId: string): Promise<void> {
  const limits = await limitsFor(tx, orgId);
  assertNotSuspended(limits);
  await assertActiveJobs(tx, orgId, limits);

  const used = await storageBytesUsed(tx, orgId);
  if (used >= limits.storageBytes) {
    throw quotaExceeded(
      `This organization is out of storage (${formatGb(used)} of ${formatGb(limits.storageBytes)}), ` +
        `so there is nowhere to put the exported file. Delete a project or an old export first.`,
    );
  }
}
