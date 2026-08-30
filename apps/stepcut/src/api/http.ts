// HTTP transport for apps/stepcut-api. Same-origin under `/api` — in dev via
// Vite's proxy, in production via Caddy — so the session cookie is a plain
// httpOnly first-party cookie and there is no CORS path that only exists
// locally.
//
// Copied from apps/web/src/api/http.ts. Unlike apps/web, there is no
// mock-mode wrapper module in front of this one (no `api/index.ts`,
// no `api/mock.ts`) — apps/stepcut has no desktop counterpart that needs a
// standalone-in-browser fallback, so every caller here imports this file
// directly.
//
// Phase 1 kept only `request`/`ApiError`/`setUnauthorizedHandler` — no
// upload or render routes existed yet. Phase 2 adds the upload flow, so
// `putToStorage`/`putPart` are back (copied from the same source file); the
// progress-stream helper (`subscribeProgress`) still isn't needed — StepCut
// has no SSE stream (see `apps/stepcut-worker/src/progress.ts`'s header),
// and the dashboard polls `GET /api/videos` instead.

const BASE = import.meta.env.VITE_API_BASE ?? "/api";

/** An error the API reported, carrying its status so callers can tell
 * "not found" from "not allowed" from "the server fell over". */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Notified when the API rejects a request for want of a session.
 *
 * Registered by `auth/SessionGate`, and only there. A session can expire or
 * be revoked while the app is open; reporting it here lets the gate re-read
 * the session and show the sign-in screen, without any view learning that
 * auth exists.
 */
let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

async function toError(response: Response): Promise<ApiError> {
  // `apps/stepcut-api` returns `{ "error": "..." }`; fall back to the status
  // line for anything that isn't ours (a proxy 502, say).
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as { error?: string };
    if (body?.error) message = body.error;
  } catch {
    // Non-JSON body — keep the status line.
  }
  return new ApiError(response.status, message);
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    // The session cookie is httpOnly and set by `better-auth`; the SPA never
    // reads or attaches a token itself.
    credentials: "include",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    if (response.status === 401) unauthorizedHandler?.();
    throw await toError(response);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Uploads bytes straight to object storage with a server-minted presigned
 * URL — the API never proxies video. Deliberately a bare `fetch`, not
 * `request`: the target is MinIO/R2, not our API, and it must not carry our
 * session cookie. */
export async function putToStorage(url: string, file: Blob, contentType: string): Promise<void> {
  const response = await fetch(url, {
    method: "PUT",
    body: file,
    headers: { "Content-Type": contentType },
    credentials: "omit",
  });
  if (!response.ok) {
    throw new ApiError(response.status, `Upload failed (${response.status} ${response.statusText})`);
  }
}

/**
 * Uploads one part of a multipart upload and returns its ETag, which the
 * completion call needs in order to assemble the object.
 *
 * No `Content-Type` — S3 takes the type from the `CreateMultipartUpload` that
 * opened the upload, and sending one here would not match what the URL was
 * signed for.
 */
export async function putPart(url: string, part: Blob): Promise<string> {
  const response = await fetch(url, { method: "PUT", body: part, credentials: "omit" });
  if (!response.ok) {
    throw new ApiError(response.status, `Upload failed (${response.status} ${response.statusText})`);
  }
  const etag = response.headers.get("ETag");
  if (!etag) {
    throw new ApiError(response.status, "Upload failed: storage did not return an ETag for this part.");
  }
  return etag;
}
