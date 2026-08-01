// Transport selection. `src/db.ts` imports from here and never learns which
// backend answered.
//
// `apps/api` doesn't exist until M3, so until then the SPA runs against an
// in-memory mock — that is what makes M1 verifiable on its own ("the desktop
// UI renders and is clickable in a browser") instead of being unfinished
// work waiting on the API. Set `VITE_API_MODE=live` to talk to a real API
// during M3 development; production builds are always live, since the mock
// is behind `import.meta.env.DEV` and dynamically imported, so it is not in
// the production bundle at all.

import * as http from "./http";

export { ApiError, setUnauthorizedHandler } from "./http";

const USE_MOCK = import.meta.env.DEV && import.meta.env.VITE_API_MODE !== "live";

/** Whether this build talks to the mock rather than a real API. Read by
 * `auth/SessionGate`, which steps aside when there is no API to hold a session
 * — mock mode has no `/api/auth` to sign in against. Nothing else should
 * branch on it: the point of this module is that callers cannot tell. */
export const isMockMode = USE_MOCK;

type MockModule = typeof import("./mock");

let mockModule: Promise<MockModule> | null = null;
function mock(): Promise<MockModule> {
  if (!mockModule) mockModule = import("./mock");
  return mockModule;
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (USE_MOCK) return (await mock()).mockRequest<T>(method, path, body);
  return http.request<T>(method, path, body);
}

export async function requestOrNull<T>(method: string, path: string): Promise<T | null> {
  if (USE_MOCK) {
    const { mockRequest, MockNotFound } = await mock();
    try {
      return await mockRequest<T>(method, path);
    } catch (err) {
      if (err instanceof MockNotFound) return null;
      throw err;
    }
  }
  return http.requestOrNull<T>(method, path);
}

export async function putToStorage(url: string, file: Blob, contentType: string): Promise<void> {
  if (USE_MOCK) return (await mock()).mockPutToStorage(url, file);
  return http.putToStorage(url, file, contentType);
}

export async function putPart(url: string, part: Blob): Promise<string> {
  if (USE_MOCK) return (await mock()).mockPutPart(url, part);
  return http.putPart(url, part);
}

/** Progress subscription (plan D4). Synchronous return of an unsubscribe,
 * matching what `useVideoProgress` expects; the mock path resolves its
 * subscription immediately, so the two behave identically from the hook's
 * side. */
export function subscribeProgress<T>(handler: (event: T) => void): () => void {
  if (USE_MOCK) {
    let unsubscribe: (() => void) | null = null;
    let cancelled = false;
    void mock().then((m) => {
      if (cancelled) return;
      unsubscribe = m.mockSubscribeProgress(handler as (event: unknown) => void);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }
  return http.subscribeProgress<T>(handler);
}
