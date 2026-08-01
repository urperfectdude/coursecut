// The progress stream (D4).
//
// Desktop pushes a `VideoProgress` struct over a Tauri event channel;
// `useVideoProgress` consumes the struct, not raw events, so on the web only
// the subscription line changes. This is the server side of that line: an SSE
// stream of the identical payload.
//
// SSE rather than WebSockets because progress is one-directional — the
// browser never sends anything back — and a second protocol would mean a
// second thing to proxy, secure and reconnect. `EventSource` also reconnects
// on its own, which is most of what a websocket layer would have been for.
//
// Scoping is not this file's decision: `events.ts` filters by org before a
// handler ever sees an event, and `org_id` is stripped on the way out because
// the SPA has no use for it.

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "../http/context.js";
import { subscribeProgress } from "../events.js";

export const progressRoutes = new Hono<AppEnv>();

/** How often to send a comment frame. Anything less than a proxy's idle
 * timeout will do; Caddy's default is well above this. */
const KEEPALIVE_MS = 25_000;

progressRoutes.get("/progress", (c) => {
  const orgId = c.get("orgId");

  return streamSSE(c, async (stream) => {
    const queue: string[] = [];
    let wake: (() => void) | null = null;

    const unsubscribe = await subscribeProgress(orgId, (event) => {
      // `org_id` never leaves the server: the browser is already scoped to one
      // tenant by its session and has no field to put it in. Rebuilt field by
      // field rather than spread-minus-one, so a field added to
      // `ProgressEvent` later has to be added here consciously instead of
      // leaking by default.
      queue.push(
        JSON.stringify({
          video_id: event.video_id,
          stage: event.stage,
          fraction: event.fraction,
          detail: event.detail,
          attempt: event.attempt,
        }),
      );
      wake?.();
    });

    stream.onAbort(() => {
      unsubscribe();
      wake?.();
    });

    try {
      while (!stream.aborted) {
        if (queue.length === 0) {
          // Park until an event arrives or the keepalive is due, rather than
          // polling — a stream open for a 40-minute transcode should cost
          // nothing while nothing is happening.
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, KEEPALIVE_MS).unref?.();
          });
          wake = null;
          if (stream.aborted) break;
          if (queue.length === 0) {
            await stream.writeSSE({ data: "", event: "keepalive" });
            continue;
          }
        }
        const data = queue.shift()!;
        // The event name matches desktop's channel name, so the client-side
        // listener reads the same string it does on the desktop app.
        await stream.writeSSE({ data, event: "video-progress" });
      }
    } finally {
      unsubscribe();
    }
  });
});
