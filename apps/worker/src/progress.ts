// Progress reporting, worker side (plan D4).
//
// Desktop emits a `VideoProgress` struct on a Tauri channel. Here the same
// struct goes out as a Postgres `NOTIFY` that `apps/api` relays to the browser
// over SSE — the API is a different process, and eventually a different
// droplet, so the database is the only thing both are guaranteed to share.
//
// Two writes per report, deliberately different in cost:
//
//   * the `NOTIFY`, on every throttled tick, because that is what the UI reads
//     and it is cheap — no row is touched;
//   * the `jobs` row, at most every few seconds, because it is tenant-scoped
//     and therefore a transaction. It is the durable record (what a restarted
//     API or a future Jobs view would read), not the live feed.
//
// Both are best-effort: a progress write failing must never fail the work it
// is describing. Desktop swallows its emit errors for the same reason.

import { getDb, withOrg } from "../../api/src/db/client.js";
import { publishProgress, type ProgressEvent } from "../../api/src/events.js";
import { eq } from "../../api/src/db/ops.js";
import { jobs } from "../../api/src/db/schema.js";

export type Stage = ProgressEvent["stage"];

/** How often the durable `jobs` row is refreshed while a stage runs. */
const ROW_WRITE_INTERVAL_MS = 3000;

export interface ProgressReporter {
  /** `fraction === null` is the indeterminate case the UI renders as a
   * spinner rather than a bar. */
  (fraction: number | null, detail: string | null): void;
}

/**
 * A reporter for one job's stage.
 *
 * Fire-and-forget by design: the caller is inside an ffmpeg read loop or a
 * chunk upload loop and has nothing useful to do with a failed progress write,
 * so nothing here returns a promise to await or an error to handle.
 */
export function makeReporter(job: {
  jobId: string;
  orgId: string;
  videoId: string;
  attempt: number;
  stage: Stage;
}): ProgressReporter {
  let lastRowWrite = 0;

  return (fraction, detail) => {
    const event: ProgressEvent = {
      org_id: job.orgId,
      video_id: job.videoId,
      stage: job.stage,
      fraction,
      detail,
      attempt: job.attempt,
    };
    // Not inside a transaction: `NOTIFY` is held until commit, and a stream
    // that only delivered once the whole job committed would defeat the point.
    void publishProgress(getDb(), event).catch(() => {});

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
