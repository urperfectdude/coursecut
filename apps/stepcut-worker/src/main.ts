// The worker process for stepcut (docs/stepcut-plan.md's Phase 1 scaffold).
//
//   cd apps/stepcut-worker && npm run dev
//
// A separate npm project from `apps/stepcut-api`, but not a separate
// dependency tree: it imports `apps/stepcut-api`'s db client and env module
// directly, relying on Node's ESM bare-specifier resolution walking up from
// this file's own location to land on `apps/stepcut-api/node_modules` — the
// same trick `apps/worker` uses today for `apps/api`. That is also why this
// package's own `package.json` carries almost no dependencies: everything
// beyond `graphile-worker` + `tsx` is resolved from `stepcut-api`'s install.
//
// **It connects as the unprivileged app role**, the same one that will serve
// requests once tenant tables exist. `DATABASE_ADMIN_URL` is never opened
// here.
//
// Phase 1 has no product task yet (docs/stepcut-plan.md's phases 2-5 add
// `extract`/analysis/render). `taskList` is a single throwaway `ping` task
// that proves the queue delivers work end to end; it is deleted once a real
// task exists. There is also no `reconcileInterrupted()` here yet — that
// exists in `apps/worker` to un-stick `running` rows in a `jobs` table, and
// stepcut has no `jobs` table until Phase 2 — and no scratch directory to
// clear, since nothing touches ffmpeg yet.

import { run, type Runner } from "graphile-worker";
import { closePool } from "../../stepcut-api/src/db/client.js";
import { env } from "../../stepcut-api/src/env.js";

/** Long enough that an idle worker is not a busy loop, short enough that a
 * queued job feels immediate. `graphile-worker` also listens for the insert
 * notification, so this is the ceiling, not the typical latency. */
const POLL_INTERVAL_MS = 2000;

async function main(): Promise<void> {
  const runner: Runner = await run({
    connectionString: env.databaseUrl(),
    concurrency: 1,
    pollInterval: POLL_INTERVAL_MS,
    taskList: {
      // Throwaway proof that the queue delivers work end to end. Not a
      // product task — deleted once Phase 2 adds `extract`.
      ping: async (payload: unknown) => {
        console.log("[stepcut-worker] ping", payload);
      },
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

await main();
