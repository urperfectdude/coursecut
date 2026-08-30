// The worker process for stepcut.
//
//   cd apps/stepcut-worker && npm run dev
//
// A separate npm project from `apps/stepcut-api`, but not a separate
// dependency tree: it imports `apps/stepcut-api`'s db client, env, schema,
// storage, openai and jobs/queue modules directly, relying on Node's ESM
// bare-specifier resolution walking up from each importing file's own
// location to land on `apps/stepcut-api/node_modules` — the same trick
// `apps/worker` uses today for `apps/api`.
//
// **It connects as the unprivileged app role**, the same one that serves
// requests. `DATABASE_ADMIN_URL` is never opened here.
//
// Phase 2 (docs/stepcut-plan.md §8: "Upload & transcript") replaces Phase
// 1's throwaway `ping` task with the real `extract`/`transcribe` pipeline
// (`tasks/video.ts`), and adds the scratch-directory and stuck-job cleanup a
// real pipeline needs at startup — Phase 1 had neither because there was
// nothing yet that could get stuck.

import { run, type Runner } from "graphile-worker";
import { closePool, getDb, withOrg } from "../../stepcut-api/src/db/client.js";
import { and, eq } from "../../stepcut-api/src/db/ops.js";
import { env } from "../../stepcut-api/src/env.js";
import { RENDER_TASK, VIDEO_TASK, WEBHOOK_TASK } from "../../stepcut-api/src/jobs/queue.js";
import { jobs, organizations, renders, videos } from "../../stepcut-api/src/db/schema.js";
import { clearScratch } from "./scratch.js";
import { runRenderJob, type RenderJobPayload } from "./tasks/render.js";
import { runVideoJob, type VideoJobPayload } from "./tasks/video.js";
import { runWebhookJob, type WebhookJobPayload } from "./tasks/webhook.js";

/** Long enough that an idle worker is not a busy loop, short enough that a
 * queued job feels immediate. `graphile-worker` also listens for the insert
 * notification, so this is the ceiling, not the typical latency. */
const POLL_INTERVAL_MS = 2000;

async function main(): Promise<void> {
  // Fail here rather than one job at a time: a worker with no key would
  // accept transcription jobs and fail every one of them.
  env.openAiApiKey();

  await clearScratch();
  await reconcileInterrupted();

  const runner: Runner = await run({
    connectionString: env.databaseUrl(),
    concurrency: 1,
    pollInterval: POLL_INTERVAL_MS,
    taskList: {
      [VIDEO_TASK]: (payload) => runVideoJob(payload as VideoJobPayload),
      [RENDER_TASK]: (payload) => runRenderJob(payload as RenderJobPayload),
      [WEBHOOK_TASK]: (payload, helpers) => runWebhookJob(payload as WebhookJobPayload, helpers),
    },
  });

  console.log("[stepcut-worker] ready");

  const shutdown = async (signal: string) => {
    console.log(`[stepcut-worker] ${signal} — shutting down`);
    await runner.stop().catch(() => undefined);
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
 * A row that says `running` while nothing is running will say it forever,
 * which is a genuinely confusing stuck-forever state to hit the very first
 * time this worker restarts mid-job during development — cheap enough to
 * guard against now rather than deferring it, unlike the SSE stream or
 * quotas this phase otherwise skips.
 *
 * Safe **because there is one worker** at concurrency 1. Running a second
 * worker would need this narrowed to jobs this instance owned.
 *
 * It walks orgs one at a time: `jobs` is RLS-covered, so there is no
 * cross-tenant scan available to the role this process connects as.
 */
async function reconcileInterrupted(): Promise<void> {
  const orgs = await getDb().select({ id: organizations.id }).from(organizations);

  for (const org of orgs) {
    await withOrg(org.id, async (tx) => {
      const stuckJobs = await tx
        .update(jobs)
        .set({
          state: "failed",
          error: "This step was interrupted (the worker restarted) — retry it to run it again.",
          updatedAt: new Date(),
        })
        .where(eq(jobs.state, "running"))
        .returning({ videoId: jobs.videoId, renderId: jobs.renderId });

      // A video whose extract or transcribe died mid-run has to end up in
      // `error`, or there is no visible way to tell it apart from one still
      // in progress.
      for (const job of stuckJobs) {
        if (!job.videoId) continue;
        await tx
          .update(videos)
          .set({ transcriptStatus: "error", updatedAt: new Date() })
          .where(eq(videos.id, job.videoId));
      }

      // Same reasoning for a render: `runRenderJob` marks both its `jobs` row
      // and the `renders` row `running` (see `tasks/render.ts`'s header for
      // why this task, unlike `video.ts`'s, owns the `jobs` row directly), so
      // a crash mid-render leaves both stuck unless this loop closes the
      // second one too. No retry surface exists for a render yet — the
      // message points at starting a fresh one instead.
      for (const job of stuckJobs) {
        if (!job.renderId) continue;
        await tx
          .update(renders)
          .set({
            status: "failed",
            error: "This render was interrupted (the worker restarted) — start a new render to try again.",
            updatedAt: new Date(),
          })
          .where(and(eq(renders.id, job.renderId), eq(renders.status, "running")));
      }

      if (stuckJobs.length > 0) {
        console.log(`[stepcut-worker] reconciled ${stuckJobs.length} job(s) in ${org.id}`);
      }
    });
  }
}

await main();
