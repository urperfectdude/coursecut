// The Hono app, assembled.
//
// Built as a value rather than started here, so the contract tests can drive
// it with `app.fetch(request)` without binding a port — `server.ts` is the
// only thing that listens.
//
// Everything is mounted under `/api`, which is what makes the session cookie
// simple: the SPA is served from the same origin (Vite proxies in dev, Caddy
// in production), so the cookie is a plain first-party httpOnly cookie and
// there is no CORS path that exists only locally. That is worth more than it
// sounds — cross-origin cookie handling is where auth bugs that only appear
// in one environment come from.
//
// Route order matters twice, and both are load-bearing:
//
//   1. `/api/auth/*` is mounted **before** `requireOrg`, because signing in is
//      how you get a session; requiring one first would be a deadlock.
//   2. Literal paths (`/videos/playback-url`, `/lessons/merge`) are registered
//      before their `:id` siblings so they are never captured as ids.

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { getAuth } from "./auth.js";
import { isMailConfigured } from "./mail.js";
import { requireOrg, type AppEnv } from "./http/context.js";
import { EXPENSIVE, GENERAL, isExpensive, rateLimit } from "./http/rate-limit.js";
import { usageRoutes } from "./routes/usage.js";
import { exportRoutes } from "./routes/exports.js";
import { lessonRoutes } from "./routes/lessons.js";
import { orgRoutes } from "./routes/orgs.js";
import { progressRoutes } from "./routes/progress.js";
import { projectRoutes } from "./routes/projects.js";
import { settingsRoutes } from "./routes/settings.js";
import { transcriptRoutes } from "./routes/transcript.js";
import { videoRoutes } from "./routes/videos.js";

export function createApp() {
  const app = new Hono<AppEnv>();

  // Every failure leaves as `{ "error": "..." }`, which is the one shape
  // `apps/web/src/api/http.ts` parses and the copied views render.
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    // An unexpected error's message could carry anything, so it does not go
    // out. Plan §9 keeps that rule for logs too: paths, ids and error codes,
    // never transcript text or file contents.
    console.error("[api] unhandled error", err);
    return c.json({ error: "Something went wrong on the server." }, 500);
  });

  app.get("/api/health", (c) => c.json({ ok: true }));

  /**
   * What this deployment can do, for a client that has no session yet (M7).
   *
   * One field today: whether password reset exists. The SPA renders the
   * "Forgot password?" link only when it does, because mail is an optional
   * deployment (`MAIL_DRIVER` unset is supported) and a link to a flow the
   * server will refuse is worse than no link — the same reasoning D7 applies
   * to the desktop key UI, and why M4 shipped no reset form at all.
   *
   * Deliberately unauthenticated and deliberately boring: it says what the
   * server is configured to do, never anything about who is asking.
   */
  app.get("/api/config", (c) => c.json({ password_reset: isMailConfigured() }));

  // Sign-in, sign-up, sign-out, password reset, and the organization plugin's
  // own routes (including set-active, which writes the session column
  // `requireOrg` reads). Rate limiting for these is `better-auth`'s own, keyed
  // by IP — see `auth.ts`. Below `requireOrg` there is a user id to key on,
  // which is a better key, so the two limiters are separate.
  app.all("/api/auth/*", (c) => getAuth().handler(c.req.raw));

  const api = new Hono<AppEnv>();
  api.use("*", requireOrg);
  // After `requireOrg`, because both rules key on the caller's user id — an
  // unauthenticated request has already been refused by then, so a flood of
  // them cannot fill the buckets of a user who does exist.
  api.use("*", rateLimit(GENERAL));
  api.use("*", async (c, next) =>
    isExpensive(c.req.method, c.req.path) ? rateLimit(EXPENSIVE)(c, next) : next(),
  );
  api.route("/", orgRoutes);
  api.route("/", usageRoutes);
  api.route("/", projectRoutes);
  api.route("/", videoRoutes);
  api.route("/", transcriptRoutes);
  api.route("/", lessonRoutes);
  api.route("/", settingsRoutes);
  api.route("/", exportRoutes);
  api.route("/", progressRoutes);

  app.route("/api", api);

  return app;
}

export type App = ReturnType<typeof createApp>;
