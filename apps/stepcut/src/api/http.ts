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
// Only `request`/`ApiError`/`setUnauthorizedHandler` are kept — the upload
// (`putToStorage`/`putPart`) and progress-stream (`subscribeProgress`) helpers
// from the source file aren't used by anything in Phase 1 (no upload/render
// routes exist yet) and are left out rather than carried along unused.

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
