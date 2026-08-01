// M7's acceptance criterion: "a second org can be onboarded safely" (plan §7).
//
// Safely means three separable things, and this suite is organised as those
// three:
//
//   * **Cost is bounded.** A tenant cannot spend unbounded Whisper minutes or
//     unbounded storage on the platform's key (D7). The interesting cases are
//     not the happy refusals — they are the ways a client could get around
//     one: lying about a file's size, deleting a video to refund the month's
//     transcription, or signing up again for a fresh allowance.
//   * **Storage does not grow forever.** Abandoned uploads, expired exports
//     and objects no row points at are collected, and a deleted tenant takes
//     its bytes with it.
//   * **A refusal is a sentence, not a stack trace.** Every gate returns the
//     `{ error }` shape the copied views already render, with a status the
//     client can act on — 402 for a quota (retrying will not help) rather than
//     429 (retrying will).
//
// It drives the shipped client (`apps/web/src/db.ts`) wherever the flow has
// one, for the same reason the contract suite does: a re-typed copy would keep
// passing after the two sides drifted.
//
//   docker compose -f infra/postgres/compose.yml up -d --wait
//   cd apps/api && npm run db:reset && npm test

import { serve } from "@hono/node-server";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { closePool, withOrg } from "../src/db/client.js";
import { closeProgressListener } from "../src/events.js";
import { SEED, SEED_PASSWORD, seed } from "../src/db/seed.js";
import * as schema from "../src/db/schema.js";
import * as storage from "../src/storage.js";
import { consume, resetRateLimits } from "../src/http/rate-limit.js";
import { periodStart, TRANSCRIPTION_SECONDS } from "../src/quota.js";
import { sweepOrg } from "../src/retention.js";
import { installBrowserGlobals, signIn } from "./browser.js";
import * as db from "../../web/src/db.js";
import { ApiError } from "../../web/src/api/http.js";

const ORG = SEED.orgA.id;

let server: ReturnType<typeof serve>;
let origin: string;

function fakeVideo(name: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type: "video/mp4" });
}

/** Sets this org's limit overrides. Not something the product can do — the
 * columns are the platform's side of the bargain and `routes/settings.ts`
 * never writes them (see `schema.ts`) — so a test writes them the way an
 * operator would. */
function setLimits(limits: Partial<typeof schema.orgSettings.$inferInsert>): Promise<unknown> {
  return withOrg(ORG, (tx) =>
    tx
      .insert(schema.orgSettings)
      .values({ orgId: ORG, ...limits })
      .onConflictDoUpdate({ target: schema.orgSettings.orgId, set: limits }),
  );
}

/** Clears every override, so one test's ceiling is not the next one's. */
function clearLimits(): Promise<unknown> {
  return setLimits({
    transcriptionMinutesLimit: null,
    storageBytesLimit: null,
    retentionDays: null,
    suspendedAt: null,
    suspendedReason: null,
  });
}

/** Bills the org for `minutes` in the current period, as the worker would. */
function recordMinutes(minutes: number): Promise<unknown> {
  return withOrg(ORG, (tx) =>
    tx.insert(schema.usageEvents).values({
      id: `usage_test_${Math.random().toString(36).slice(2)}`,
      orgId: ORG,
      kind: TRANSCRIPTION_SECONDS,
      quantity: minutes * 60,
    }),
  );
}

function clearUsage(): Promise<unknown> {
  return withOrg(ORG, (tx) => tx.delete(schema.usageEvents));
}

/** Ages a row, so a sweep with a 24-hour grace period has something to find
 * without the test sleeping through it. */
function backdate(table: "videos", id: string, days: number): Promise<unknown> {
  return withOrg(ORG, (tx) =>
    tx.execute(
      sql`update ${sql.identifier(table)} set created_at = now() - ${`${days} days`}::interval where id = ${id}`,
    ),
  );
}

/** The status a rejected `db.ts` call reports. Every gate must come back as a
 * status the client can branch on, not as a 500. */
async function statusOf(call: Promise<unknown>): Promise<number> {
  try {
    await call;
    return 0;
  } catch (err) {
    if (err instanceof ApiError) return err.status;
    throw err;
  }
}

beforeAll(async () => {
  await seed();
  server = serve({ fetch: createApp().fetch, port: 0 });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  origin = `http://127.0.0.1:${port}`;
  installBrowserGlobals(origin);
  await signIn(SEED.userA.email, SEED_PASSWORD);
}, 60_000);

afterEach(async () => {
  await clearLimits();
  await clearUsage();
  // The per-user limiter is process-global and the suite makes hundreds of
  // calls as one user; without this the later tests would be throttled by the
  // earlier ones, which is the limiter working and the suite failing.
  resetRateLimits();
});

afterAll(async () => {
  server?.close();
  await closeProgressListener();
  await closePool();
});

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

describe("storage quota", () => {
  it("refuses a file bigger than the org has room for, before any bytes move", async () => {
    const project = await db.createProject("Storage quota");
    await setLimits({ storageBytesLimit: 1024 });

    const status = await statusOf(db.importVideos(project.id, [fakeVideo("big.mp4", 64 * 1024)]));
    // 402 rather than 429: waiting does not help, and a client that treats a
    // quota as a rate limit will retry forever.
    expect(status).toBe(402);

    // Refused at the ticket, so no row was created either — the org is not
    // left with a `pending` video for an upload that never had permission.
    expect(await db.listVideos(project.id)).toHaveLength(0);

    await clearLimits();
    await db.deleteProject(project.id);
  });

  it("refuses an upload that lied about its size, and does not keep the bytes", async () => {
    // The ticket is issued against a number the browser sent. This is the case
    // that makes the quota an enforcement rather than an honour system: ask
    // for room for 100 bytes, PUT 64 KiB, and the completion — which knows the
    // real size, because it heads the object anyway — refuses.
    const project = await db.createProject("Understated size");
    await setLimits({ storageBytesLimit: 8 * 1024 });

    const ticket = await post<{ video_id: string; upload: { mode: string; url: string } }>(
      `/projects/${project.id}/uploads`,
      { filename: "sneaky.mp4", size: 100, content_type: "video/mp4" },
    );
    expect(ticket.upload.mode).toBe("single");
    await fetch(ticket.upload.url, {
      method: "PUT",
      body: new Blob([new Uint8Array(64 * 1024)]),
      headers: { "content-type": "video/mp4" },
    });

    // Relative, so `browser.ts`'s cookie jar attaches the session the way a
    // browser would — the same path `db.ts` takes.
    const completion = await fetch(`/api/videos/${ticket.video_id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(completion.status).toBe(402);

    // And the object it declined is gone rather than stored unbilled.
    const row = await withOrg(ORG, async (tx) => {
      const [video] = await tx
        .select()
        .from(schema.videos)
        .where(eq(schema.videos.id, ticket.video_id))
        .limit(1);
      return video;
    });
    expect(row?.uploadStatus).toBe("failed");
    expect(await storage.headObject(row!.storageKey)).toBeNull();

    await clearLimits();
    await db.deleteProject(project.id);
  });

  it("counts what is stored and frees it when a project is deleted", async () => {
    const project = await db.createProject("Storage accounting");
    const before = await usage();
    const [video] = await db.importVideos(project.id, [fakeVideo("clip.mp4", 32 * 1024)]);
    expect(video).toBeDefined();

    const after = await usage();
    expect(after.storage.bytes_used - before.storage.bytes_used).toBe(32 * 1024);

    await db.deleteProject(project.id);
    const freed = await usage();
    expect(freed.storage.bytes_used).toBe(before.storage.bytes_used);
  });
});

describe("transcription quota", () => {
  it("refuses to start the pipeline once the month's minutes are spent", async () => {
    const project = await db.createProject("Transcription quota");
    const [video] = await db.importVideos(project.id, [fakeVideo("lecture.mp4", 1024)]);

    await setLimits({ transcriptionMinutesLimit: 10 });
    await recordMinutes(10);

    // Extraction is the head of the chain — it queues transcription itself —
    // so it is where the refusal has to land to be a sentence the user reads
    // rather than a failed job they have to go looking for.
    expect(await statusOf(db.extractAudioForVideo(video!.id, 1))).toBe(402);
    expect(await statusOf(db.transcribeVideo(video!.id, 1))).toBe(402);

    // Analysis is *not* refused: it re-reads a transcript already paid for.
    await setLimits({ transcriptionMinutesLimit: 10 });
    expect(await statusOf(db.analyzeVideo(video!.id, 1))).toBe(0);

    await db.deleteProject(project.id);
  });

  it("keeps billing a deleted video's minutes, so deleting cannot refund", async () => {
    // `usage_events` has no foreign key to `videos` precisely for this: if it
    // cascaded, a tenant at their limit could delete a video and get the month
    // back, and every limit above would be advisory.
    const project = await db.createProject("Usage survives deletion");
    const [video] = await db.importVideos(project.id, [fakeVideo("lecture.mp4", 1024)]);

    await withOrg(ORG, (tx) =>
      tx.insert(schema.usageEvents).values({
        id: `usage_test_${Math.random().toString(36).slice(2)}`,
        orgId: ORG,
        kind: TRANSCRIPTION_SECONDS,
        quantity: 600,
        videoId: video!.id,
      }),
    );
    const billed = await usage();
    expect(billed.transcription.minutes_used).toBeCloseTo(10, 1);

    await db.deleteProject(project.id);
    const afterDelete = await usage();
    expect(afterDelete.transcription.minutes_used).toBeCloseTo(10, 1);
  });

  it("counts only the current calendar month", async () => {
    await recordMinutes(30);
    await withOrg(ORG, (tx) =>
      tx.execute(sql`update usage_events set occurred_at = ${periodStart()}::timestamptz - interval '1 day'`),
    );
    expect((await usage()).transcription.minutes_used).toBe(0);
  });
});

describe("suspension", () => {
  it("stops an org spending, and leaves its data reachable", async () => {
    const project = await db.createProject("Suspended org");
    const [video] = await db.importVideos(project.id, [fakeVideo("clip.mp4", 1024)]);

    await setLimits({ suspendedAt: new Date(), suspendedReason: "unpaid invoice" });

    expect(await statusOf(db.importVideos(project.id, [fakeVideo("another.mp4", 1024)]))).toBe(402);
    expect(await statusOf(db.extractAudioForVideo(video!.id, 1))).toBe(402);

    // Reads keep working: suspension is a cost control, not a way to hold a
    // tenant's data hostage. So does deleting, which is how they leave.
    expect(await db.listVideos(project.id)).toHaveLength(1);
    expect(await db.getPlaybackUrl(video!.file_path)).toContain("http");

    await clearLimits();
    await db.deleteProject(project.id);
  });
});

// ---------------------------------------------------------------------------
// Abuse limits
// ---------------------------------------------------------------------------

describe("rate limiting", () => {
  it("allows a burst up to the ceiling and then reports how long to wait", () => {
    resetRateLimits();
    for (let i = 0; i < 5; i += 1) {
      expect(consume("test:user", 5, 60_000)).toBeNull();
    }
    const retryAfter = consume("test:user", 5, 60_000);
    expect(retryAfter).not.toBeNull();
    expect(retryAfter!).toBeGreaterThan(0);

    // A different key is a different bucket — one noisy user must not throttle
    // everyone else, which is the whole reason this keys on the user id rather
    // than on the IP the way the auth limiter has to.
    expect(consume("test:other", 5, 60_000)).toBeNull();
  });

  it("forgets a bucket once its window has passed", () => {
    resetRateLimits();
    const now = Date.now();
    expect(consume("test:window", 1, 1000, now)).toBeNull();
    expect(consume("test:window", 1, 1000, now + 100)).not.toBeNull();
    expect(consume("test:window", 1, 1000, now + 1500)).toBeNull();
  });
});

describe("the active-job cap", () => {
  it("gives a cancelled export's slot back", async () => {
    // The bug this pins was invisible until something counted: cancelling an
    // export marked the `exports` row and left its `jobs` row `queued`
    // forever, so every cancelled export permanently consumed a slot of the
    // org's budget. Nothing read that row before the cap existed.
    const project = await db.createProject("Cancelled export slot");
    const [video] = await db.importVideos(project.id, [fakeVideo("clip.mp4", 1024)]);
    const lesson = await db.createLesson(video!.id, "Doomed", [{ start: 0, end: 2 }]);

    const before = (await usage()).jobs.active;
    const [queued] = await db.queueExport([lesson.id], "");
    expect((await usage()).jobs.active).toBe(before + 1);

    await db.cancelExport(queued!.id);
    expect((await usage()).jobs.active).toBe(before);

    await db.deleteProject(project.id);
  });

  it("refuses to queue past the ceiling", async () => {
    const project = await db.createProject("Job cap");
    const [video] = await db.importVideos(project.id, [fakeVideo("clip.mp4", 1024)]);
    const lesson = await db.createLesson(video!.id, "Repeatedly exported", [{ start: 0, end: 1 }]);

    const limit = (await usage()).jobs.limit;
    const queued: string[] = [];
    let refused = 0;
    for (let i = 0; i < limit + 2; i += 1) {
      try {
        const [row] = await db.queueExport([lesson.id], "");
        queued.push(row!.id);
      } catch (err) {
        refused = err instanceof ApiError ? err.status : 0;
        break;
      }
    }
    expect(refused).toBe(402);

    for (const id of queued) await db.cancelExport(id);
    await db.deleteProject(project.id);
  }, 60_000);
});

describe("organization creation cap", () => {
  it("refuses a user who already owns the maximum", async () => {
    // Without this cap, "sign up again" is a quota reset: a new org is a fresh
    // month of transcription minutes for the price of a form submission.
    const max = Number(process.env.QUOTA_MAX_ORGS_PER_USER ?? 3);
    const created: string[] = [];

    // Ada owns Acme already (the seed), so she is one in.
    let refusedAt = 0;
    for (let i = 0; i < max + 2; i += 1) {
      const response = await fetch("/api/auth/organization/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `Quota Org ${i}`, slug: `quota-org-${Date.now()}-${i}` }),
      });
      if (response.ok) {
        created.push(((await response.json()) as { id: string }).id);
      } else {
        refusedAt = i;
        expect(await response.text()).toMatch(/limit/i);
        break;
      }
    }

    expect(refusedAt).toBeGreaterThan(0);
    // One seeded org plus what it let through equals the cap.
    expect(created.length + 1).toBe(max);

    for (const id of created) {
      await fetch("/api/auth/organization/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: id }),
      });
    }
    // Deleting the last-created org clears the session's active org; put it
    // back so the tests after this one are still Acme's.
    await fetch("/api/auth/organization/set-active", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId: ORG }),
    });
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

describe("the retention sweep", () => {
  it("purges an upload the browser abandoned", async () => {
    const project = await db.createProject("Abandoned upload");
    const ticket = await post<{ video_id: string; storage_key: string; upload: { url: string } }>(
      `/projects/${project.id}/uploads`,
      { filename: "half.mp4", size: 4096, content_type: "video/mp4" },
    );
    // Bytes that arrived, for a row that never completed — the exact state a
    // browser dying mid-upload leaves behind.
    await fetch(ticket.upload.url, {
      method: "PUT",
      body: new Blob([new Uint8Array(4096)]),
      headers: { "content-type": "video/mp4" },
    });
    await backdate("videos", ticket.video_id, 2);

    const result = await sweepOrg(ORG);
    expect(result.errors).toEqual([]);
    expect(result.abandonedUploads).toBeGreaterThanOrEqual(1);
    expect(await db.getVideo(ticket.video_id)).toBeNull();
    expect(await storage.headObject(ticket.storage_key)).toBeNull();

    await db.deleteProject(project.id);
  });

  it("expires a finished export's file and keeps the history row", async () => {
    const project = await db.createProject("Expiring export");
    const [video] = await db.importVideos(project.id, [fakeVideo("clip.mp4", 1024)]);
    const lesson = await db.createLesson(video!.id, "Expiring lesson", [{ start: 0, end: 5 }]);

    // Stand in for a finished encode: an object in storage, a `done` row, and
    // a download window that has already closed.
    const [exportRow] = await db.queueExport([lesson.id], "");
    await putObject(exportRow!.output_path, new Uint8Array(2048));
    await withOrg(ORG, (tx) =>
      tx
        .update(schema.exports)
        .set({
          status: "done",
          progress: 1,
          sizeBytes: 2048,
          downloadExpiresAt: new Date(Date.now() - 60_000),
        })
        .where(eq(schema.exports.id, exportRow!.id)),
    );

    const result = await sweepOrg(ORG);
    expect(result.expiredExports).toBeGreaterThanOrEqual(1);
    expect(await storage.headObject(exportRow!.output_path)).toBeNull();

    // The row survives, in a status no copied view has a button for — Export
    // History renders it as a plain badge rather than as a link to a 404.
    const listed = await db.listExports(project.id);
    expect(listed.find((row) => row.id === exportRow!.id)?.status).toBe("expired");

    await db.deleteProject(project.id);
  });

  it("collects objects no row points at, and spares the ones still settling", async () => {
    // The backstop for every best-effort delete in the codebase: a project
    // delete whose `deletePrefix` failed, a cancelled export's leftovers, an
    // upload that landed while its transaction rolled back.
    const orphan = `${ORG}/orphaned/${Date.now()}/left-behind.mp4`;
    await putObject(orphan, new Uint8Array(512));

    // Fresh, so the grace period must protect it: an object written seconds
    // before its row commits is not an orphan.
    const result = await sweepOrg(ORG);
    expect(result.errors).toEqual([]);
    expect(await storage.headObject(orphan)).not.toBeNull();
    expect(result.orphanedObjects).toBe(0);

    // Past the grace window — simulated by moving the window rather than
    // waiting a day. `-1` puts the cutoff an hour in the *future*, and that
    // is not laziness about picking `0`: MinIO stamps `LastModified` from its
    // own clock, which runs tens of milliseconds ahead of this process's, so a
    // zero-length window would leave a just-written object looking like it is
    // from the future. That skew is one of the things the real grace period
    // absorbs (see `sweepOrphanedObjects`).
    const previous = process.env.RETENTION_ORPHAN_GRACE_HOURS;
    process.env.RETENTION_ORPHAN_GRACE_HOURS = "-1";
    try {
      const aged = await sweepOrg(ORG);
      expect(aged.orphanedObjects).toBeGreaterThanOrEqual(1);
      expect(await storage.headObject(orphan)).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.RETENTION_ORPHAN_GRACE_HOURS;
      else process.env.RETENTION_ORPHAN_GRACE_HOURS = previous;
    }
  });

  it("honours a source retention window only when one is set", async () => {
    const project = await db.createProject("Retention window");
    const [video] = await db.importVideos(project.id, [fakeVideo("old.mp4", 1024)]);
    await backdate("videos", video!.id, 40);

    // Default is off: an old video is not something to delete because nobody
    // chose a window.
    expect((await sweepOrg(ORG)).retiredVideos).toBe(0);
    expect(await db.getVideo(video!.id)).not.toBeNull();

    await setLimits({ retentionDays: 30 });
    const swept = await sweepOrg(ORG);
    expect(swept.retiredVideos).toBeGreaterThanOrEqual(1);
    expect(await db.getVideo(video!.id)).toBeNull();
    expect(await storage.headObject(video!.file_path)).toBeNull();

    await clearLimits();
    await db.deleteProject(project.id);
  });
});

// ---------------------------------------------------------------------------
// The reporting surface
// ---------------------------------------------------------------------------

describe("GET /usage", () => {
  it("reports the numbers the Usage dialog renders", async () => {
    await setLimits({ transcriptionMinutesLimit: 120, storageBytesLimit: 1024 ** 3 });
    await recordMinutes(15);

    const body = await usage();
    expect(body.transcription).toMatchObject({ minutes_used: 15, minutes_limit: 120 });
    expect(body.storage.bytes_limit).toBe(1024 ** 3);
    expect(body.jobs.limit).toBeGreaterThan(0);
    // What the privacy section states must come from the server, or the page
    // can promise a window the sweep is not running.
    expect(typeof body.retention.export_days).toBe("number");
    expect(body.suspended).toBeNull();
    expect(Date.parse(body.period_start)).toBe(periodStart().getTime());
  });
});

// ---------------------------------------------------------------------------
// Helpers that need the session cookie
// ---------------------------------------------------------------------------

interface UsageBody {
  period_start: string;
  transcription: { minutes_used: number; minutes_limit: number };
  storage: { bytes_used: number; bytes_limit: number; max_upload_bytes: number };
  jobs: { active: number; limit: number };
  retention: { source_days: number; export_days: number };
  suspended: { since: string; reason: string | null } | null;
}

function usage(): Promise<UsageBody> {
  // Through the patched global fetch, so the cookie jar applies.
  return fetch("/api/usage").then((response) => response.json() as Promise<UsageBody>);
}

function post<T>(path: string, body: unknown): Promise<T> {
  return fetch(`/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (response) => {
    if (!response.ok) throw new ApiError(response.status, await response.text());
    return response.json() as Promise<T>;
  });
}

/**
 * Puts bytes at a key, the way the browser does: a server-minted presigned
 * URL, never an `S3Client` built here. Storage access lives in exactly one
 * module (plan §3.4 rule 2), and a test reaching around it would be the first
 * place that rule broke.
 */
async function putObject(key: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  const url = await storage.presignPut(key, "application/octet-stream");
  const response = await fetch(url, {
    method: "PUT",
    body: new Blob([bytes]),
    headers: { "content-type": "application/octet-stream" },
  });
  if (!response.ok) throw new Error(`putObject failed: ${response.status}`);
}
