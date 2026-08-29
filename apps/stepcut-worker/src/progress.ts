// Progress reporting, worker side.
//
// apps/worker/src/progress.ts writes two things per report: a Postgres
// `NOTIFY` (`publishProgress`) that `apps/api` relays to the browser over
// SSE, and a throttled write to the `jobs` row itself (the durable record).
//
// **This is a deliberate Phase 2 simplification: only the `jobs`-row half
// exists here.** A progress SSE stream (a listener process, an EventSource
// endpoint) is real infra weight StepCut doesn't need yet for "prove a
// transcript appears after upload" — `apps/stepcut`'s dashboard polls
// `GET /api/videos` on an interval instead of subscribing to a stream (see
// that view's header). The two-write split in the coursecut original is
// exactly the seam a future SSE addition would slot into: add a
// `publishProgress` call here, alongside this one, the same way apps/worker
// does it — nothing about this reporter's shape would need to change.
//
// Best-effort by design: a progress write failing must never fail the work
// it is describing.

import { withOrg } from "../../stepcut-api/src/db/client.js";
import { eq } from "../../stepcut-api/src/db/ops.js";
import { jobs } from "../../stepcut-api/src/db/schema.js";

/** How often the `jobs` row is refreshed while a stage runs. */
const ROW_WRITE_INTERVAL_MS = 3000;

export interface ProgressReporter {
  /** `fraction === null` is the indeterminate case — no bar to draw yet. */
  (fraction: number | null, detail: string | null): void;
}

/**
 * A reporter for one job.
 *
 * Fire-and-forget by design: the caller is inside an ffmpeg read loop or a
 * chunk upload loop and has nothing useful to do with a failed progress
 * write, so nothing here returns a promise to await or an error to handle.
 */
export function makeReporter(job: { jobId: string; orgId: string }): ProgressReporter {
  let lastRowWrite = 0;

  return (fraction, detail) => {
    const now = Date.now();
    if (now - lastRowWrite < ROW_WRITE_INTERVAL_MS) return;
    lastRowWrite = now;
    void withOrg(job.orgId, (tx) =>
      tx
        .update(jobs)
        .set({ progress: fraction, detail, updatedAt: new Date() })
        .where(eq(jobs.id, job.jobId)),
    ).catch(() => {});
  };
}
