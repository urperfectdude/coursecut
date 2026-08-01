// Per-job scratch space.
//
// ffmpeg needs a seekable local file, so every job that touches video pulls
// the source object down first (plan §3.4: on R2 that download is free at both
// ends, which is half of why R2 was chosen). Nothing here is meant to survive
// the job that created it: the directory is removed on every exit path, and
// `clearScratch` wipes the tree at worker startup for the jobs a crash never
// got to clean up.
//
// Plan §3.3 sizes the droplet on exactly this assumption — 50 GB is fine
// "since R2 holds the video; only scratch space is local".

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { env } from "../../api/src/env.js";

/**
 * Runs `fn` with a private directory, removed afterwards whatever happens.
 *
 * `jobId` only shapes the directory's name — the random suffix is what makes
 * it unique, so a retry of the same job cannot inherit a half-written file
 * from the attempt before it.
 */
export async function withScratchDir<T>(jobId: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const root = env.workerScratchDir();
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, `${jobId.slice(0, 8)}-`));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Empties the scratch root.
 *
 * Desktop's equivalent (`reconcile_interrupted_exports`) removes its whole
 * `export_tmp` directory at startup on the same reasoning: a crash mid-job
 * skips every in-process cleanup path, and with one worker running one job at
 * a time, anything left here belongs to a session that is over.
 */
export async function clearScratch(): Promise<void> {
  await rm(env.workerScratchDir(), { recursive: true, force: true });
  await mkdir(env.workerScratchDir(), { recursive: true });
}
