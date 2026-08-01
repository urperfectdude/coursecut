// Environment for every `apps/api` entry point. Read once, here, so a
// missing variable fails at startup with a name rather than at the first
// query with a connection error.
//
// Two database URLs, deliberately (plan §6):
//
//   DATABASE_URL       — the app role. **No BYPASSRLS**, no ownership of the
//                        tables. This is what serves requests, and RLS is
//                        real for it.
//   DATABASE_ADMIN_URL — the privileged role. Runs migrations and the
//                        bootstrap, and nothing else. Never used to serve a
//                        request; if it were, every policy in `0001_rls.sql`
//                        would silently stop applying.
//
// The isolation test asserts the first of those is genuinely unprivileged,
// so a deploy that points both at `postgres` fails CI rather than production.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Load `apps/api/.env` if it is there. Absent is normal and fine — in CI and
// on the droplet the variables come from the environment itself, and this
// file must never be required for the process to start.
const dotenv = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(dotenv)) process.loadEnvFile(dotenv);

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Copy apps/api/.env.example to apps/api/.env for local development.`,
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
  /** Least-privilege role used to serve requests. Subject to RLS. */
  databaseUrl: () => required("DATABASE_URL"),
  /** Privileged role used only by migrate/bootstrap/seed. */
  adminDatabaseUrl: () => required("DATABASE_ADMIN_URL"),
  /** Role name granted by the bootstrap; must match DATABASE_URL's user. */
  appDbUser: () => optional("APP_DB_USER", "coursecut_app"),
  appDbPassword: () => required("APP_DB_PASSWORD"),

  /** Port the HTTP server listens on. Vite proxies `/api` here in dev. */
  port: () => Number(optional("PORT", "3000")),

  /**
   * Public origin of the app, used by `better-auth` to build callback and
   * reset-password URLs and as its trusted origin. In dev that is the Vite
   * server (which proxies `/api` here, so the API is same-origin with the
   * SPA); in production it is the Caddy-terminated domain.
   */
  appUrl: () => optional("APP_URL", "http://localhost:5173"),

  /**
   * Session-signing secret. Required — `better-auth` will invent one in
   * development otherwise, and a secret that changes on restart logs everyone
   * out in a way that looks like a bug in the session code.
   */
  authSecret: () => required("AUTH_SECRET"),

  // --- OpenAI (D7) ---
  //
  // One platform-owned key for every tenant. It is read here and used only by
  // `src/openai.ts`; it is never stored in the database (`org_settings` has no
  // column for it) and never sent to the browser. Required rather than
  // optional: a worker that boots without it would fail every transcription
  // job one at a time instead of refusing to start.
  openAiApiKey: () => required("OPENAI_API_KEY"),
  /**
   * Overridable so the pipeline tests can point the same code at a local stub
   * instead of spending real money — and, later, so a deployment can route
   * through a gateway. No trailing slash; paths are appended verbatim.
   */
  openAiBaseUrl: () => optional("OPENAI_BASE_URL", "https://api.openai.com/v1").replace(/\/+$/, ""),

  // --- Worker (M5) ---
  //
  // Only the worker reads these; the API has no ffmpeg and no scratch disk.
  /** ffmpeg/ffprobe binaries. Desktop bundles them as sidecars; here they are
   * the system binaries locally and pinned in the worker image for prod. */
  ffmpegPath: () => optional("FFMPEG_PATH", "ffmpeg"),
  ffprobePath: () => optional("FFPROBE_PATH", "ffprobe"),
  /**
   * Where a job's source video, extracted audio and per-segment cuts live
   * while it runs. Everything under here is transient — a job removes its own
   * directory on every exit path, and the worker clears the whole tree at
   * startup (plan §3.3: only scratch space is local, R2 holds the video).
   */
  workerScratchDir: () => optional("WORKER_SCRATCH_DIR", "/tmp/coursecut-worker"),

  // --- Object storage (plan §3.4) ---
  //
  // MinIO locally, Cloudflare R2 in production. Both speak S3, so only these
  // five values differ between the two; `src/storage.ts` is the only consumer.
  s3Endpoint: () => required("S3_ENDPOINT"),
  s3Region: () => optional("S3_REGION", "auto"),
  s3Bucket: () => required("S3_BUCKET"),
  s3AccessKeyId: () => required("S3_ACCESS_KEY_ID"),
  s3SecretAccessKey: () => required("S3_SECRET_ACCESS_KEY"),
  /** MinIO needs path-style addressing; R2 does not. */
  s3ForcePathStyle: () => optionalBool("S3_FORCE_PATH_STYLE", false),
  /**
   * Presigned URLs are short-lived by design — a leaked one should expire
   * before it is useful. Playback URLs are re-minted per page load; upload
   * part URLs need long enough for one part to cross a slow connection.
   */
  s3UrlTtlSeconds: () => Number(optional("S3_URL_TTL_SECONDS", "3600")),

  // --- Quotas and cost caps (M7, plan D7) -----------------------------------
  //
  // The platform holds the OpenAI key, so the meter runs on however much video
  // a tenant uploads (plan §4's D7 note: this is what makes quotas gate the
  // first untrusted signup rather than being a hardening nicety). Every value
  // below is a *default*; `org_settings` overrides it per tenant, and null
  // there means "whatever this says".
  //
  // The numbers are deliberately conservative rather than generous. Raising a
  // ceiling for a tenant who hit it is a one-line UPDATE; refunding a month of
  // Whisper spend is not.
  /** Minutes of audio per org per calendar month. 10 hours ≈ $3.60 of Whisper. */
  quotaTranscriptionMinutes: () => Number(optional("QUOTA_TRANSCRIPTION_MINUTES_PER_MONTH", "600")),
  /** Bytes of source video + finished exports an org may have stored at once. */
  quotaStorageBytes: () => Number(optional("QUOTA_STORAGE_BYTES", String(50 * 1024 ** 3))),
  /** Ceiling on a single upload. Below the 5 TiB S3 allows, by a lot. */
  quotaMaxUploadBytes: () => Number(optional("QUOTA_MAX_UPLOAD_BYTES", String(5 * 1024 ** 3))),
  /**
   * Queued-or-running jobs one org may have at a time. The worker is
   * concurrency 1 (plan §3.3), so this is not about capacity — it is about one
   * tenant being unable to put a thousand jobs in front of everybody else's.
   *
   * 25 rather than something tighter because an ordinary act has to fit inside
   * it: importing a semester of lectures in one go is twenty extract jobs, and
   * a limit an honest batch import trips is a bug report rather than a
   * defence. The abuse it exists to stop is three orders of magnitude away
   * from that.
   */
  quotaMaxActiveJobs: () => Number(optional("QUOTA_MAX_ACTIVE_JOBS", "25")),
  /**
   * Orgs one user may create. Without a cap, "sign up again" is a quota reset:
   * every new org starts a fresh monthly allowance, and creating them costs a
   * form submission.
   */
  quotaMaxOrgsPerUser: () => Number(optional("QUOTA_MAX_ORGS_PER_USER", "3")),

  // --- Retention (M7, plan §9) ----------------------------------------------
  /**
   * Days a finished export's MP4 stays downloadable. This one has a real
   * default because an export is *derived* — deleting it costs the user a
   * re-export, not their data — and it is the storage line that would
   * otherwise grow without anyone deciding to keep anything.
   */
  retentionExportDays: () => Number(optional("RETENTION_EXPORT_DAYS", "14")),
  /**
   * Days a source video is kept. **0 means never expire**, which is the
   * default: purging a tenant's uploads on a timer they did not ask for is not
   * something to switch on by accident, and cost is bounded by the storage
   * quota instead. Per-org override lives in `org_settings.retention_days`.
   */
  retentionSourceDays: () => Number(optional("RETENTION_SOURCE_DAYS", "0")),
  /** How long a `pending` upload row (browser died mid-upload) is given before
   * the sweep purges it and its parts. */
  retentionPendingUploadHours: () => Number(optional("RETENTION_PENDING_UPLOAD_HOURS", "24")),
  /**
   * Grace period before an object with no row pointing at it is deleted. Long
   * enough that an object written seconds before its row commits is never
   * mistaken for an orphan.
   */
  retentionOrphanGraceHours: () => Number(optional("RETENTION_ORPHAN_GRACE_HOURS", "24")),
  /** Cron for the retention sweep, in `graphile-worker`'s crontab syntax. */
  retentionSweepCron: () => optional("RETENTION_SWEEP_CRON", "20 4 * * *"),

  // --- Transactional email (M7; plan §10's last open row) --------------------
  //
  // Driver-agnostic on purpose. The plan left the provider undecided and both
  // M3 and M4 shipped around it; what was actually blocking was picking a
  // vendor, not writing the code, so the code takes either.
  //
  //   unset/"none"  no mail. Password reset does not exist — no link, no form,
  //                 no route. A reset form whose mail never arrives is worse
  //                 than an absent one (the same reasoning D7 applies to the
  //                 desktop key UI).
  //   "log"         prints the link to the server log. For local development.
  //   "resend"      real delivery over Resend's HTTP API. Swapping to Postmark
  //                 or SES is another branch in `mail.ts`, not a redesign.
  mailDriver: () => optional("MAIL_DRIVER", "none").toLowerCase(),
  mailFrom: () => optional("MAIL_FROM", "CourseCut <no-reply@localhost>"),
  mailApiKey: () => process.env.MAIL_API_KEY ?? "",
  mailApiUrl: () => optional("MAIL_API_URL", "https://api.resend.com/emails"),
};
