// Environment for every `apps/stepcut-api` entry point. Read once, here, so a
// missing variable fails at startup with a name rather than at the first
// query with a connection error.
//
// Two database URLs, deliberately (mirrors apps/api/src/env.ts):
//
//   DATABASE_URL       — the app role. **No BYPASSRLS**, no ownership of the
//                        tables. This is what serves requests.
//   DATABASE_ADMIN_URL — the privileged role. Runs `db:create`, migrations
//                        and the bootstrap, and nothing else. Never used to
//                        serve a request.
//
// Phase 1's surface was deliberately smaller than apps/api's: no OpenAI, S3,
// quota, retention or mail vars. Phase 2 ("Upload & transcript") adds OpenAI
// (Whisper only — no GPT-5.5 call exists yet) and S3, since `extract` and
// `transcribe` need both. Quota/retention/mail still don't exist here — that
// stays true through Phase 6.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Load `apps/stepcut-api/.env` if it is there. Absent is normal and fine —
// in CI and on the droplet the variables come from the environment itself,
// and this file must never be required for the process to start.
const dotenv = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(dotenv)) process.loadEnvFile(dotenv);

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Copy apps/stepcut-api/.env.example to apps/stepcut-api/.env for local development.`,
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function optionalBool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

export const env = {
  /** Least-privilege role used to serve requests. Subject to RLS once
   * `TENANT_TABLES` is non-empty (see src/db/schema.ts). */
  databaseUrl: () => required("DATABASE_URL"),
  /** Privileged role used only by db:create/bootstrap/migrate. */
  adminDatabaseUrl: () => required("DATABASE_ADMIN_URL"),
  /** Role name granted by the bootstrap; must match DATABASE_URL's user. */
  appDbUser: () => optional("APP_DB_USER", "stepcut_app"),
  appDbPassword: () => required("APP_DB_PASSWORD"),

  /** Port the HTTP server listens on. Vite proxies `/api` here in dev. */
  port: () => Number(optional("PORT", "3001")),

  /**
   * Public origin of the app, used by `better-auth` to build callback URLs
   * and as its trusted origin. In dev that is the Vite server (which proxies
   * `/api` here, so the API is same-origin with the SPA); in production it
   * is the Caddy-terminated domain.
   */
  appUrl: () => optional("APP_URL", "http://localhost:5174"),

  /**
   * Session-signing secret. Required — `better-auth` will invent one in
   * development otherwise, and a secret that changes on restart logs
   * everyone out in a way that looks like a bug in the session code.
   */
  authSecret: () => required("AUTH_SECRET"),

  // --- OpenAI (Phase 2) — Whisper only ---
  //
  // One platform-owned key for every tenant, mirroring apps/api's D7: read
  // here and used only by `src/openai.ts`, never stored in the database and
  // never sent to the browser. Required rather than optional — a worker that
  // boots without it would accept transcription jobs and fail every one of
  // them one at a time instead of refusing to start. No GPT-5.5 call exists
  // in StepCut yet (that arrives in Phase 3 with its own prompt, never a fork
  // of coursecut's lesson-analysis one — plan §9), so there is nothing else
  // OpenAI-related to read here.
  openAiApiKey: () => required("OPENAI_API_KEY"),
  /** Overridable so tests can point at a local stub; leave unset for the
   * real thing. No trailing slash — paths are appended verbatim. */
  openAiBaseUrl: () => optional("OPENAI_BASE_URL", "https://api.openai.com/v1").replace(/\/+$/, ""),

  // --- Worker only (Phase 2) ---
  //
  // Only `apps/stepcut-worker` reads these; the API has no ffmpeg and no
  // scratch disk.
  /** ffmpeg/ffprobe binaries — the system binaries locally, pinned in the
   * worker image for production. */
  ffmpegPath: () => optional("FFMPEG_PATH", "ffmpeg"),
  ffprobePath: () => optional("FFPROBE_PATH", "ffprobe"),
  /**
   * Where a job's source video and extracted audio live while it runs.
   * Distinct from apps/worker's `/tmp/coursecut-worker` so the two products'
   * scratch trees can never collide on the same droplet.
   */
  workerScratchDir: () => optional("WORKER_SCRATCH_DIR", "/tmp/stepcut-worker"),
  /**
   * A `.ttf`/`.otf` file for `drawtext` to render title cards with (Phase 5).
   * Empty ("not set") is fine on a dev machine, which already has system
   * fonts fontconfig can fall back to — but the worker's Docker image in
   * production is not guaranteed to ship any font at all, and `drawtext`
   * without a resolvable font fails the whole render rather than degrading
   * gracefully. Set this in the worker image; leave it unset locally.
   */
  titleCardFontPath: () => optional("TITLE_CARD_FONT_PATH", ""),

  // --- Object storage (Phase 2) ---
  //
  // Same bucket as coursecut-web (`S3_BUCKET=coursecut` locally), a disjoint
  // `stepcut/` key prefix — see `src/storage.ts`. MinIO locally, Cloudflare
  // R2 in production; only the endpoint, credentials and path-style
  // addressing differ, all of it here.
  s3Endpoint: () => required("S3_ENDPOINT"),
  s3Region: () => optional("S3_REGION", "auto"),
  s3Bucket: () => required("S3_BUCKET"),
  s3AccessKeyId: () => required("S3_ACCESS_KEY_ID"),
  s3SecretAccessKey: () => required("S3_SECRET_ACCESS_KEY"),
  /** MinIO needs path-style addressing; R2 does not. */
  s3ForcePathStyle: () => optionalBool("S3_FORCE_PATH_STYLE", false),
  /** Presigned URLs are short-lived by design. */
  s3UrlTtlSeconds: () => Number(optional("S3_URL_TTL_SECONDS", "3600")),
};
