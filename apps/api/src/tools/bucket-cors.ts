// Configures the media bucket's CORS policy, and prints it back (M6).
//
//   npm run storage:cors            # allow APP_URL's origin (+ StepCut's, below)
//   npm run storage:cors -- --show  # print the current policy, change nothing
//   npm run storage:cors -- https://staging.example.com   # extra origins
//
// Run once per bucket, and again whenever `APP_URL` changes. It is a CLI
// rather than something the API does at boot because it is a one-time
// deployment step against a resource the app's own token may not be permitted
// to reconfigure — and an API that rewrites its bucket's policy on every
// restart is an API that can quietly widen it.
//
// The S3 calls live in `../storage.ts` with every other one (plan §3.4 rule
// 2); this file only decides which origins to pass and prints the result.
//
// **`PutBucketCors` replaces the whole ruleset — it does not merge.**
// StepCut (docs/stepcut-plan.md) shares this exact bucket under a `stepcut/`
// key prefix, so its browser uploads/downloads need their own CORS origin
// allowed on the *same* bucket, even though `apps/stepcut-api` is a fully
// separate app with its own `env.ts` this file has no access to. Without
// `STEPCUT_ORIGIN` below, a plain `npm run storage:cors` run from `apps/api`
// (the ordinary case — no one thinks to pass StepCut's domain as an "extra
// origin" when they're only touching coursecut) would silently drop
// StepCut's rule and break its uploads with a CORS-shaped "Failed to fetch",
// exactly like the bug this constant was added to stop from recurring.

import { env } from "../env.js";
import { applyBucketCors, getBucketCors } from "../storage.js";

const STEPCUT_ORIGIN = "https://stepcut.duckdns.org";

function originOf(url: string): string {
  return new URL(url).origin;
}

async function show(): Promise<void> {
  const rules = await getBucketCors();
  if (rules === null) {
    console.log(`bucket ${env.s3Bucket()} has no CORS configuration`);
    return;
  }
  console.log(`bucket ${env.s3Bucket()} CORS:`);
  console.log(JSON.stringify(rules, null, 2));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--show")) {
    await show();
    return;
  }

  // `APP_URL` is the origin the SPA is actually served from, so it is the one
  // that has to be allowed; anything else is an extra passed on the command
  // line (a staging domain, say). Deriving it rather than taking it as an
  // argument means the bucket and `better-auth`'s trusted origin cannot drift
  // apart. `STEPCUT_ORIGIN` is always included too, unconditionally — see
  // this file's header for why a sibling product's origin has to survive a
  // plain, no-args run of this tool.
  const origins = [originOf(env.appUrl()), STEPCUT_ORIGIN, ...args.map(originOf)];

  try {
    await applyBucketCors(origins);
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "NotImplemented") {
      // MinIO. Its CORS is server-wide (`MINIO_API_CORS_ALLOW_ORIGIN` in
      // `infra/postgres/compose.yml`) and already correct for local
      // development, so this is a no-op rather than a failure.
      console.log(
        "storage does not implement PutBucketCors — this is MinIO, whose CORS " +
          "is server-wide and set in infra/postgres/compose.yml. Nothing to do.",
      );
      return;
    }
    throw err;
  }

  console.log(`applied CORS to ${env.s3Bucket()} for ${origins.join(", ")}`);
  await show();
}

await main();
