// Retention and garbage collection (M7, plan §9).
//
// Plan §9 promises three things this file is responsible for keeping true:
// "users can delete a project and have its objects purged", "define a
// retention window and honour it", and — implicitly, because it is what makes
// the first two believable — that nothing keeps paying for objects nobody
// points at any more.
//
// Four sweeps, in the order they run, each one independent so a failure in one
// does not stop the rest:
//
//   1. **Abandoned uploads.** A `videos` row exists from the moment its
//      presigned PUT is minted (see `routes/videos.ts`), so a browser that
//      dies mid-upload leaves a `pending` row and possibly some multipart
//      parts. After a grace period both go.
//   2. **Expired exports.** An export's MP4 is derived — losing it costs a
//      re-export, not data — and it is the storage line that grows without
//      anyone deciding to keep anything. Past `download_expires_at` the object
//      is deleted and the row moves to `expired`, which Export History renders
//      as a plain badge with no download button rather than a link to a 404.
//   3. **Source retention.** Only when the org (or the platform) has actually
//      set a window. Off by default — see `org_settings.retention_days`.
//   4. **Orphaned objects.** The backstop for every best-effort delete in the
//      codebase: `deletePrefix` after a project delete, the cancelled export's
//      cleanup, an upload that completed into storage while its transaction
//      rolled back. Anything under an org's prefix that no row claims, older
//      than the grace period, is removed.
//
// **It runs per org, inside `withOrg`.** There is no cross-tenant scan here
// even though a sweep is exactly the kind of job that would want one: the
// process doing it connects as the app role, RLS applies, and a bug in this
// file therefore cannot delete another tenant's objects. The org list comes
// from `organizations`, which is not tenant data (see `0001_rls.sql`).
//
// It is driven by the worker on a cron (`apps/worker/src/main.ts`) and by
// `npm run retention:sweep` for an operator who wants it now.

import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { getDb, withOrg } from "./db/client.js";
import { env } from "./env.js";
import { exports as exportsTable, organizations, videos } from "./db/schema.js";
import { limitsFor } from "./quota.js";
import * as storage from "./storage.js";

export interface SweepResult {
  orgId: string;
  abandonedUploads: number;
  expiredExports: number;
  retiredVideos: number;
  orphanedObjects: number;
  errors: string[];
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Sweeps every org. Returns one result per org, including the ones that
 * failed — a sweep is a maintenance job, and one tenant's storage error must
 * not stop the other tenants being cleaned up. */
export async function sweepAll(): Promise<SweepResult[]> {
  const orgs = await getDb().select({ id: organizations.id }).from(organizations);
  const results: SweepResult[] = [];
  for (const org of orgs) {
    results.push(await sweepOrg(org.id));
  }
  return results;
}

export async function sweepOrg(orgId: string): Promise<SweepResult> {
  const result: SweepResult = {
    orgId,
    abandonedUploads: 0,
    expiredExports: 0,
    retiredVideos: 0,
    orphanedObjects: 0,
    errors: [],
  };

  const step = async (name: string, run: () => Promise<number>) => {
    try {
      return await run();
    } catch (err) {
      // Plan §9's logging rule: ids and error codes, never content. The org id
      // is an id; the message is the storage layer's, which never carries one.
      result.errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  };

  result.abandonedUploads = await step("abandoned-uploads", () => sweepAbandonedUploads(orgId));
  result.expiredExports = await step("expired-exports", () => sweepExpiredExports(orgId));
  result.retiredVideos = await step("source-retention", () => sweepRetiredVideos(orgId));
  result.orphanedObjects = await step("orphans", () => sweepOrphanedObjects(orgId));

  return result;
}

// ---------------------------------------------------------------------------
// 1. Abandoned uploads
// ---------------------------------------------------------------------------

/**
 * Purges `pending`/`failed` upload rows older than the grace period.
 *
 * The row is deleted first and the objects afterwards, matching the order
 * every other delete in this codebase uses: a storage failure must never roll
 * back a row delete, because a re-run of this sweep will find the objects as
 * orphans (step 4) and finish the job, whereas a half-committed transaction
 * has nobody to finish it.
 */
async function sweepAbandonedUploads(orgId: string): Promise<number> {
  const cutoff = new Date(Date.now() - env.retentionPendingUploadHours() * HOUR_MS);

  const doomed = await withOrg(orgId, async (tx) => {
    const rows = await tx
      .select({ id: videos.id, projectId: videos.projectId })
      .from(videos)
      .where(and(sql`${videos.uploadStatus} in ('pending', 'failed')`, lt(videos.createdAt, cutoff)));
    if (rows.length === 0) return rows;
    await tx.delete(videos).where(
      inArray(
        videos.id,
        rows.map((row) => row.id),
      ),
    );
    return rows;
  });

  for (const row of doomed) {
    await storage.deletePrefix(storage.videoPrefix(orgId, row.projectId, row.id));
  }
  return doomed.length;
}

// ---------------------------------------------------------------------------
// 2. Expired exports
// ---------------------------------------------------------------------------

/**
 * Deletes the objects of exports whose download window has passed.
 *
 * The row stays. Export History is a record of what was exported and when, and
 * dropping the row would make a lesson look as though it had never been
 * exported at all. `expired` is a status no copied view knows, which is
 * deliberate and safe: `getExportStatusBadgeClassName` falls back to the plain
 * outline badge for an unknown status, and every action button in
 * `ExportHistoryView` is gated on a status that is not this one — so the row
 * renders as a greyed-out fact with nothing to click, which is what it is.
 */
async function sweepExpiredExports(orgId: string): Promise<number> {
  const now = new Date();

  const doomed = await withOrg(orgId, async (tx) => {
    const rows = await tx
      .select({ id: exportsTable.id, outputKey: exportsTable.outputKey })
      .from(exportsTable)
      .where(
        and(
          eq(exportsTable.status, "done"),
          isNotNull(exportsTable.downloadExpiresAt),
          lt(exportsTable.downloadExpiresAt, now),
        ),
      );
    if (rows.length === 0) return rows;
    await tx
      .update(exportsTable)
      .set({ status: "expired", sizeBytes: null })
      .where(
        inArray(
          exportsTable.id,
          rows.map((row) => row.id),
        ),
      );
    return rows;
  });

  for (const row of doomed) {
    await storage.deleteObject(row.outputKey);
  }
  return doomed.length;
}

// ---------------------------------------------------------------------------
// 3. Source retention
// ---------------------------------------------------------------------------

/**
 * Purges source videos older than the org's retention window — rows, cascaded
 * children (transcript, lessons, exports) and objects alike.
 *
 * A window of 0 means never, which is the default. This is the one sweep that
 * destroys something a user created and did not ask to lose, so it only ever
 * runs against a number somebody chose.
 */
async function sweepRetiredVideos(orgId: string): Promise<number> {
  const days = await withOrg(orgId, async (tx) => (await limitsFor(tx, orgId)).retentionDays);
  if (!days || days <= 0) return 0;

  const cutoff = new Date(Date.now() - days * DAY_MS);

  const doomed = await withOrg(orgId, async (tx) => {
    const rows = await tx
      .select({ id: videos.id, projectId: videos.projectId })
      .from(videos)
      .where(lt(videos.createdAt, cutoff));
    if (rows.length === 0) return rows;
    // Transcript segments, lessons, lesson segments, exports and jobs all go
    // via ON DELETE CASCADE, exactly as they do for a user-initiated delete.
    await tx.delete(videos).where(
      inArray(
        videos.id,
        rows.map((row) => row.id),
      ),
    );
    return rows;
  });

  for (const row of doomed) {
    await storage.deletePrefix(storage.videoPrefix(orgId, row.projectId, row.id));
  }
  return doomed.length;
}

// ---------------------------------------------------------------------------
// 4. Orphaned objects
// ---------------------------------------------------------------------------

/**
 * Deletes objects under this org's prefix that no row claims.
 *
 * This is the backstop the rest of the codebase is written against: every
 * object delete in `routes/` and `apps/worker/` is best-effort and post-commit,
 * on the reasoning that refusing a row delete because a bucket call failed
 * would leave the row lying about what happened. That reasoning is only honest
 * if something eventually collects what those failures leave behind, and this
 * is that something.
 *
 * The grace period is what keeps it from racing a live upload: an object
 * written seconds before its row commits is not an orphan, it is a row that
 * has not committed yet. Anything younger than the grace window is left alone,
 * whatever the database says about it.
 *
 * It absorbs one more thing, found by running this against MinIO: the object
 * store's clock is not the API's. A `LastModified` roughly 90 ms *ahead* of
 * `Date.now()` here is ordinary container drift, and a sweep comparing them
 * without slack would be deciding an object's fate on which of two machines
 * was fast. Hours of grace makes that a rounding error rather than a race.
 */
async function sweepOrphanedObjects(orgId: string): Promise<number> {
  const cutoff = new Date(Date.now() - env.retentionOrphanGraceHours() * HOUR_MS);

  const claimed = await withOrg(orgId, async (tx) => {
    const keys = new Set<string>();
    const videoRows = await tx
      .select({ storageKey: videos.storageKey, audioKey: videos.audioKey })
      .from(videos);
    for (const row of videoRows) {
      keys.add(row.storageKey);
      if (row.audioKey) keys.add(row.audioKey);
    }
    const exportRows = await tx
      .select({ outputKey: exportsTable.outputKey, status: exportsTable.status })
      .from(exportsTable);
    for (const row of exportRows) {
      // An `expired` row's object was just deleted on purpose; claiming it
      // would make this sweep protect what the previous step removed if the
      // delete failed and left the object behind.
      if (row.status !== "expired") keys.add(row.outputKey);
    }
    return keys;
  });

  const objects = await storage.listObjects(`${orgId}/`);
  const orphans = objects.filter(
    (object) => !claimed.has(object.key) && object.lastModified !== undefined && object.lastModified < cutoff,
  );
  for (const orphan of orphans) {
    await storage.deleteObject(orphan.key);
  }
  return orphans.length;
}

// ---------------------------------------------------------------------------
// Deletion of a whole tenant
// ---------------------------------------------------------------------------

/**
 * Purges everything an org has in storage.
 *
 * Called from `auth.ts`'s organization-delete hook, where the rows go away by
 * `ON DELETE CASCADE` and the objects would otherwise be left behind forever —
 * a deleted tenant leaves no row to find them from, so the orphan sweep above
 * would never see them either (it walks orgs, and this one is gone).
 *
 * Not tenant-scoped through `withOrg`, because there is nothing left to scope:
 * it is a prefix delete against a prefix that is the org id.
 */
export function purgeOrgObjects(orgId: string): Promise<number> {
  return storage.deletePrefix(`${orgId}/`);
}

/** `npm run retention:sweep` */
export async function main(): Promise<void> {
  const results = await sweepAll();
  for (const result of results) {
    console.log(
      `[retention] ${result.orgId}: ${result.abandonedUploads} abandoned upload(s), ` +
        `${result.expiredExports} expired export(s), ${result.retiredVideos} retired video(s), ` +
        `${result.orphanedObjects} orphaned object(s)` +
        (result.errors.length > 0 ? ` — errors: ${result.errors.join("; ")}` : ""),
    );
  }
}
