// The retention sweep, as a queue task (M7).
//
// The sweep itself lives in `apps/api/src/retention.ts`, next to the storage
// and schema modules it uses and where `npm run retention:sweep` can call it
// directly. This file is only the wiring: `graphile-worker`'s crontab needs a
// registered task name to fire at, and the worker is the process that already
// has a queue, a schedule and no HTTP request to hold open.
//
// It is a job like any other, which is what makes it observable — a sweep that
// throws lands in `graphile_worker.failed_jobs` rather than in a log nobody
// reads. It does not touch `jobs`, though: that table is the user-visible
// projection of *their* work (`jobs/queue.ts`), and a maintenance task showing
// up in a tenant's progress stream would be a bug.

import { sweepAll } from "../../../api/src/retention.js";

export async function runRetentionSweep(): Promise<void> {
  const results = await sweepAll();

  const totals = results.reduce(
    (sum, result) => ({
      abandonedUploads: sum.abandonedUploads + result.abandonedUploads,
      expiredExports: sum.expiredExports + result.expiredExports,
      retiredVideos: sum.retiredVideos + result.retiredVideos,
      orphanedObjects: sum.orphanedObjects + result.orphanedObjects,
    }),
    { abandonedUploads: 0, expiredExports: 0, retiredVideos: 0, orphanedObjects: 0 },
  );

  console.log(
    `[worker] retention swept ${results.length} org(s): ` +
      `${totals.abandonedUploads} abandoned upload(s), ${totals.expiredExports} expired export(s), ` +
      `${totals.retiredVideos} retired video(s), ${totals.orphanedObjects} orphaned object(s)`,
  );

  // Per-org failures are collected rather than thrown (see `sweepOrg`), so
  // they surface here — one line each, ids only, no content.
  for (const result of results) {
    if (result.errors.length > 0) {
      console.error(`[worker] retention errors in ${result.orgId}: ${result.errors.join("; ")}`);
    }
  }
}
