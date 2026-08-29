// The Hono app, assembled.
//
// Built as a value rather than started here, so a future test can drive it
// with `app.fetch(request)` without binding a port — `server.ts` is the only
// thing that listens. Mirrors apps/api/src/app.ts's shape. Phase 1
// (docs/stepcut-plan.md §8) shipped only `orgRoutes`; Phase 2 adds
// `videoRoutes` (upload/extract/transcribe/reads) alongside it.
//
// Everything is mounted under `/api`, which is what makes the session cookie
// simple: the SPA is served from the same origin (Vite proxies in dev, Caddy
// in production), so the cookie is a plain first-party httpOnly cookie.
//
// Route order matters: `/api/auth/*` is mounted **before** `requireOrg`,
// because signing in is how you get a session; requiring one first would be
// a deadlock.

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { getAuth } from "./auth.js";
import { requireOrg, type AppEnv } from "./http/context.js";
import { orgRoutes } from "./routes/orgs.js";
import { videoRoutes } from "./routes/videos.js";

export function createApp() {
  const app = new Hono<AppEnv>();

  // Every failure leaves as `{ "error": "..." }`.
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    // An unexpected error's message could carry anything, so it does not go
    // out.
    console.error("[stepcut-api] unhandled error", err);
    return c.json({ error: "Something went wrong on the server." }, 500);
  });

  app.get("/api/health", (c) => c.json({ ok: true }));

  // Sign-in, sign-up, sign-out, and the organization plugin's own routes
  // (including set-active, which writes the session column `requireOrg`
  // reads).
  app.all("/api/auth/*", (c) => getAuth().handler(c.req.raw));

  const api = new Hono<AppEnv>();
  api.use("*", requireOrg);
  api.route("/", orgRoutes);
  api.route("/", videoRoutes);

  app.route("/api", api);

  return app;
}

export type App = ReturnType<typeof createApp>;
