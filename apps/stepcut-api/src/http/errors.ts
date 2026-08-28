// One error shape for the whole API: `{ "error": "..." }`, which is what
// `apps/stepcut`'s `src/api/http.ts` (step 3) parses.
//
// Copied from apps/api/src/http/errors.ts. `tooManyRequests` is kept even
// though `rate-limit.ts` is not wired into `app.ts` yet (see that file's
// header) — cheap to keep in step with the source it is copied from.

import { HTTPException } from "hono/http-exception";

/** A failure with a status the client can act on. */
export function httpError(status: number, message: string): HTTPException {
  return new HTTPException(status as never, {
    res: Response.json({ error: message }, { status }),
  });
}

/** 404 — "no such row". */
export function notFound(what: string): HTTPException {
  return httpError(404, `${what} not found`);
}

/** 400 — the request itself is wrong. */
export function badRequest(message: string): HTTPException {
  return httpError(400, message);
}

/** 401 — no session. */
export function unauthorized(message = "Not signed in"): HTTPException {
  return httpError(401, message);
}

/** 403 — signed in, but not for this (including: no org membership yet). */
export function forbidden(message: string): HTTPException {
  return httpError(403, message);
}

/**
 * 429 — too many requests, and retrying later is the right response.
 *
 * Distinct from a quota error on purpose: a rate limit clears on its own, a
 * quota does not.
 */
export function tooManyRequests(message: string, retryAfterSeconds: number): HTTPException {
  return new HTTPException(429, {
    res: Response.json(
      { error: message },
      { status: 429, headers: { "retry-after": String(Math.ceil(retryAfterSeconds)) } },
    ),
  });
}
