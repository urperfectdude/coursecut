// Real HTTP transport for `apps/api` (M3). Same-origin under `/api` — in
// dev via Vite's proxy, in production via Caddy — so the session cookie is
// a plain httpOnly first-party cookie and there is no CORS path that only
// exists locally.
//
// Nothing above this file knows about fetch: `src/db.ts` is the only caller,
// which is what keeps the seam in one place the way desktop's `invoke()`
// wrapper does.

const BASE = import.meta.env.VITE_API_BASE ?? "/api";

/** An error the API reported, carrying its status so callers can tell
 * "not found" from "not allowed" from "the server fell over". Views only
 * ever render `.message`, matching how they render Rust's error strings on
 * desktop. */
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
 * Notified when the API rejects a request for want of a session (M4).
 *
 * Registered by `auth/SessionGate`, and only there. A session can expire or be
 * revoked while the app is open, and the copied views have no idea what a
 * session is — they would just render "Unauthorized" wherever the failure
 * happened to land. Reporting it here lets the gate re-read the session and
 * show the sign-in screen, without any view learning that auth exists.
 */
let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

async function toError(response: Response): Promise<ApiError> {
  // `apps/api` returns `{ "error": "..." }`; fall back to the status line for
  // anything that isn't ours (a proxy 502, say).
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

/** For the endpoints whose desktop counterpart resolves to `null` rather
 * than rejecting when a row is missing (`getProject`, `getVideo`). A 404 is
 * "no such row"; every other failure still throws, so a genuine error is
 * never silently rendered as an empty page. */
export async function requestOrNull<T>(method: string, path: string): Promise<T | null> {
  try {
    return await request<T>(method, path);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** Uploads bytes straight to object storage with a server-minted presigned
 * URL — the API never proxies video (plan §3.2). Deliberately a bare
 * `fetch`, not `request`: the target is R2/MinIO, not our API, and it must
 * not carry our session cookie. */
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
 * Reading that header is the one thing here that depends on storage-side
 * configuration: a cross-origin response only exposes headers the server
 * names in `Access-Control-Expose-Headers`. MinIO includes `ETag` by default
 * and R2 is configured for it at M6 (see `infra/postgres/compose.yml`); if
 * that ever regresses the symptom is this error rather than a corrupt object,
 * which is why it is checked rather than assumed.
 *
 * No `Content-Type` — S3 takes the type from the `CreateMultipartUpload` that
 * opened the upload, and sending one here would not match what the URL was
 * signed for.
 */
export async function putPart(url: string, part: Blob): Promise<string> {
  const response = await fetch(url, { method: "PUT", body: part, credentials: "omit" });
  if (!response.ok) {
    throw new ApiError(
      response.status,
      `Upload failed (${response.status} ${response.statusText})`,
    );
  }
  const etag = response.headers.get("ETag");
  if (!etag) {
    throw new ApiError(
      response.status,
      "Upload failed: storage did not return an ETag for this part.",
    );
  }
  return etag;
}

/** Subscribes to the server's progress stream (plan D4 — SSE replaces
 * Tauri's event channel). Returns an unsubscribe, mirroring `listen()`'s
 * contract so `useVideoProgress` is a verbatim copy apart from this call. */
export function subscribeProgress<T>(handler: (event: T) => void): () => void {
  const source = new EventSource(`${BASE}/progress`, { withCredentials: true });
  source.addEventListener("video-progress", (event) => {
    handler(JSON.parse((event as MessageEvent).data) as T);
  });
  // EventSource reconnects on its own; an error here is not terminal, and
  // dropping progress UI is not a reason to break the pipeline.
  return () => source.close();
}
