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
// Phase 1's surface is deliberately smaller than apps/api's: no OpenAI, S3,
// quota, retention or mail vars — those arrive with the phases that read
// them (docs/stepcut-plan.md's phase build order).

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
};
