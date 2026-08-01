// The two browser behaviours `apps/web/src/db.ts` assumes, supplied to Node
// so the contract tests can drive the real client rather than a re-typed copy
// of it.
//
// Both are deliberately minimal. This is not a browser emulation — the point
// is to run the *actual* shipped `db.ts` against the *actual* API, and
// anything more elaborate here starts testing the emulation instead.
//
//   1. **A cookie jar.** Node's `fetch` has no cookie store at all, so
//      `credentials: "include"` is a no-op and every request after sign-in
//      would arrive anonymous. This keeps the session cookie and replays it —
//      to our API only, never to object storage, matching what a browser does
//      with an httpOnly first-party cookie.
//   2. **Origin resolution.** `http.ts` requests `/api/...`, which is a
//      relative URL only a page origin can resolve. Pointing it at the test
//      server here (rather than setting `VITE_API_BASE`) keeps the client
//      running in the same same-origin configuration production uses.
//
// An `Origin` header comes along for the ride because `better-auth` refuses
// requests without one, which is itself a browser fact worth reproducing
// rather than configuring away.

const cookies = new Map<string, string>();

let apiOrigin = "";
let installed = false;
let realFetch: typeof fetch;

/** The last URL `window.open` was called with — how `revealInFolder` (D6) is
 * observed, since its whole job is to hand the browser a download. */
export let lastOpenedUrl: string | null = null;

export function installBrowserGlobals(origin: string): void {
  apiOrigin = origin;
  if (installed) return;
  installed = true;
  realFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const isOurs = raw.startsWith("/");
    const url = isOurs ? `${apiOrigin}${raw}` : raw;

    const headers = new Headers(init?.headers);
    if (isOurs) {
      headers.set("origin", apiOrigin);
      if (cookies.size > 0) {
        headers.set("cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
      }
    }

    const response = await realFetch(url, { ...init, headers });

    // Only our API's cookies are kept — a presigned PUT goes to storage, and a
    // browser would never send our session cookie there either.
    if (isOurs) {
      for (const header of response.headers.getSetCookie()) {
        const [pair] = header.split(";");
        const separator = pair.indexOf("=");
        if (separator > 0) cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1));
      }
    }
    return response;
  }) as typeof fetch;

  // `revealInFolder` opens the download URL in a new tab. Recording it is
  // enough to assert the endpoint was called and a real URL came back.
  (globalThis as { window?: unknown }).window = {
    open: (url: string) => {
      lastOpenedUrl = url;
      return null;
    },
  };
}

/** Forgets the session — used to sign in as a different tenant mid-suite. */
export function clearCookies(): void {
  cookies.clear();
}

/** Signs in through `better-auth`'s own endpoint, which is where the SPA's
 * auth screens (§4.1) will send credentials too. Deliberately not wrapped in
 * a `db.ts` helper: §4.1 keeps session handling out of that file entirely. */
export async function signIn(email: string, password: string): Promise<void> {
  const response = await fetch("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`sign-in failed: ${response.status} ${await response.text()}`);
}
