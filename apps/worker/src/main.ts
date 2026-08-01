// The worker process (plan §3.2, M5).
//
//   cd apps/api && npm run dev:worker
//
// A separate *process* from `apps/api`, not a separate npm project: ffmpeg is
// CPU-bound and long-running, and an HTTP request cannot stay open for a
// 40-minute transcode — but it imports this repo's schema, storage, events and
// OpenAI modules directly, so it shares `apps/api`'s dependency tree and its
// `.env`. Splitting it onto its own droplet (plan §3.3) changes where it runs,
// not what it imports.
//
// **It connects as the unprivileged app role**, the same one that serves
// requests. That is the whole reason every handler goes through `withOrg`: the
// worker is the process that touches the most tenant data, and it must be the
// one RLS is most real for. `DATABASE_ADMIN_URL` is never opened here.
//
// **Concurrency is 1.** ffmpeg saturates a core, and plan §3.3 is explicit
// that on the current droplet a transcode will starve the API. One job at a
// time also matches desktop's single sequential export worker, which is what
// the export UI's semantics were written against. Raising it is a deployment
// decision for after the worker moves to its own box, not a code change.

import { run, type Runner } from "graphile-worker";
import { closePool, getDb, withOrg } from "../../api/src/db/client.js";
import { env } from "../../api/src/env.js";
import { closeProgressListener } from "../../api/src/events.js";
import { EXPORT_TASK, RETENTION_TASK, VIDEO_TASK } from "../../api/src/jobs/queue.js";
import { exports as exportsTable, jobs, organizations, videos } from "../../api/src/db/schema.js";
import { eq } from "../../api/src/db/ops.js";
import { clearScratch } from "./scratch.js";
import { runExportJob, type ExportJobPayload } from "./tasks/export.js";
import { runRetentionSweep } from "./tasks/retention.js";
import { runVideoJob, type VideoJobPayload } from "./tasks/video.js";

/** Long enough that an idle worker is not a busy loop, short enough that a
 * queued export feels immediate. `graphile-worker` also listens for the
 * insert notification, so this is the ceiling, not the typical latency. */
const POLL_INTERVAL_MS = 2000;

async function main(): Promise<void> {
  // Fail here rather than one job at a time: a worker with no key would accept
  // transcription jobs and fail every one of them.
  env.openAiApiKey();

  await clearScratch();
  await reconcileInterrupted();

  const runner: Runner = await run({
    connectionString: env.databaseUrl(),
    concurrency: 1,
    pollInterval: POLL_INTERVAL_MS,
    taskList: {
      [VIDEO_TASK]: (payload) => runVideoJob(payload as VideoJobPayload),
      [EXPORT_TASK]: (payload) => runExportJob(payload as ExportJobPayload),
      [RETENTION_TASK]: () => runRetentionSweep(),
    },
    // M7's retention sweep, nightly by default (`RETENTION_SWEEP_CRON`).
    //
    // `?fill=1d` is what makes it survive a worker that was down at the hour:
    // graphile-worker backfills the missed run on startup instead of skipping
    // it, so a droplet rebooted at 04:20 does not silently stop collecting
    // orphans until the next night. `max=1` because two concurrent sweeps of
    // the same org would race each other's deletes.
    crontab: `${env.retentionSweepCron()} ${RETENTION_TASK} ?fill=1d&max=1`,
  });

  console.log("[worker] ready");

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} — shutting down`);
    await runner.stop().catch(() => undefined);
    await closeProgressListener().catch(() => undefined);
    await closePool().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await runner.promise;
}

/**
 * Marks work that a previous process died in the middle of.
 *
 * Desktop's `reconcile_interrupted_exports`, with the same reasoning: a row
 * that says `running` while nothing is running will say it forever, and the
 * user is left watching a bar that cannot move. Failing it turns that into a
 * Retry button.
 *
 * This is safe **because there is one worker**. It is the same assumption the
 * desktop app makes about its single in-process worker, and it is what
 * concurrency 1 and one deployed worker container buy. Running a second worker
 * would need this narrowed to jobs this instance owned — worth noting before
 * anyone scales the worker horizontally, which plan §3.3 anticipates.
 *
 * It has to walk orgs one at a time: `exports` and `jobs` are RLS-covered, so
 * there is no cross-tenant scan available to the role this process connects
 * as. That is the mechanism working, not fighting it.
 */
async function reconcileInterrupted(): Promise<void> {
  const orgs = await getDb().select({ id: organizations.id }).from(organizations);

  for (const org of orgs) {
    await withOrg(org.id, async (tx) => {
      const stuckExports = await tx
        .update(exportsTable)
        .set({
          status: "failed",
          progress: 0,
          error: "Export was interrupted (the worker restarted) — use Retry to run it again.",
        })
        .where(eq(exportsTable.status, "running"))
        .returning({ id: exportsTable.id });

      const stuckJobs = await tx
        .update(jobs)
        .set({
          state: "failed",
          error: "This step was interrupted (the worker restarted) — use Retry to run it again.",
          updatedAt: new Date(),
        })
        .where(eq(jobs.state, "running"))
        .returning({ videoId: jobs.videoId, kind: jobs.kind });

      // A video whose extract or transcribe died mid-run has to end up in
      // `error`, or `ProjectDetailView` shows neither a Retry button nor a
      // moving status. An interrupted *analysis* leaves it alone, for the same
      // reason a failed one does (see `tasks/video.ts`).
      for (const job of stuckJobs) {
        if (!job.videoId || (job.kind !== "extract" && job.kind !== "transcribe")) continue;
        await tx
          .update(videos)
          .set({ transcriptStatus: "error", updatedAt: new Date() })
          .where(eq(videos.id, job.videoId));
      }

      if (stuckExports.length > 0 || stuckJobs.length > 0) {
        console.log(
          `[worker] reconciled ${stuckExports.length} export(s) and ${stuckJobs.length} job(s) in ${org.id}`,
        );
      }
    });
  }
}

await main();
