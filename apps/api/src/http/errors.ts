// One error shape for the whole API: `{ "error": "..." }`, which is what
// `apps/web/src/api/http.ts` parses and what the copied views render.
//
// That matters more than it looks. On desktop every IPC command returns
// `Result<T, String>` and the views render the string; here the string comes
// out of a JSON body instead. Keeping the shape uniform is what lets the
// copied error handling stay copied.

import { HTTPException } from "hono/http-exception";

/** A failure with a status the client can act on. */
export function httpError(status: number, message: string): HTTPException {
  return new HTTPException(status as never, {
    res: Response.json({ error: message }, { status }),
  });
}

/**
 * 404 — "no such row". `requestOrNull` in the web client maps exactly this to
 * `null`, so `getProject`/`getVideo` can tell a missing row from a real
 * failure the way desktop's commands do.
 *
 * Under RLS this is also what another tenant's id looks like: the policy
 * filters the row out, the query finds nothing, and the caller is told the
 * same thing it would be told about an id that never existed. That is the
 * correct answer — confirming the id exists elsewhere would leak the fact of
 * it.
 */
export function notFound(what: string): HTTPException {
  return httpError(404, `${what} not found`);
}

/** 400 — the request itself is wrong (bad range, empty title, …). */
export function badRequest(message: string): HTTPException {
  return httpError(400, message);
}

/** 401 — no session. The SPA's route guard turns this into the sign-in screen. */
export function unauthorized(message = "Not signed in"): HTTPException {
  return httpError(401, message);
}

/** 403 — signed in, but not for this. */
export function forbidden(message: string): HTTPException {
  return httpError(403, message);
}

/**
 * 429 — too many requests, and retrying later is the right response (M7).
 *
 * Distinct from `quotaExceeded`'s 402 on purpose: a rate limit clears on its
 * own, a quota does not, and a client that cannot tell them apart will either
 * retry something that will never succeed or give up on something that would
 * have.
 */
export function tooManyRequests(message: string, retryAfterSeconds: number): HTTPException {
  return new HTTPException(429, {
    res: Response.json(
      { error: message },
      { status: 429, headers: { "retry-after": String(Math.ceil(retryAfterSeconds)) } },
    ),
  });
}
