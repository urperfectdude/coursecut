// Progress fan-out (plan D4): worker → Postgres → API → SSE → browser.
//
// Desktop emits a `VideoProgress` struct on a Tauri event channel and
// `useVideoProgress` consumes the struct rather than raw events, so the only
// thing that changes on the web is the transport. This file is that
// transport's server half.
//
// **Why Postgres LISTEN/NOTIFY and not an in-process emitter.** The thing
// producing progress is `apps/worker`, a different process — and eventually a
// different droplet (plan §3.2). An in-process EventEmitter would work
// perfectly right up until the worker moved out, which is planned. NOTIFY
// costs nothing extra: the database is already the only thing both processes
// share, and the queue is Postgres-backed for the same reason.
//
// **Why a dedicated connection.** `LISTEN` is session state. On a pooled
// connection it would be attached to whichever connection happened to serve
// the call and silently lost when that connection was recycled, so this opens
// its own client and keeps it.
//
// **Tenancy.** Every event carries its `org_id` and subscribers only ever see
// their own. That check is here rather than in the SSE route because it is the
// same check for every consumer, and one that must not be forgettable.

import { sql, type SQL } from "drizzle-orm";
import pg from "pg";
import { env } from "./env.js";

/** The channel name both this process and `apps/worker` (M5) publish on. */
export const PROGRESS_CHANNEL = "video_progress";

/**
 * Exactly desktop's `VideoProgress`, plus the org that owns it. `db.ts`
 * declares the payload the browser sees; `org_id` is stripped before it goes
 * out, because the SPA has no use for it and never sees org ids elsewhere.
 */
export interface ProgressEvent {
  org_id: string;
  video_id: string;
  stage: "ExtractingAudio" | "Transcribing" | "Analyzing";
  /** `null` means indeterminate — the UI shows a spinner, not a bar. */
  fraction: number | null;
  detail: string | null;
  attempt: number;
}

type Subscriber = (event: ProgressEvent) => void;

const subscribers = new Map<string, Set<Subscriber>>();
let listener: pg.Client | undefined;
let listening: Promise<void> | undefined;
let stopped = false;

async function connectListener(): Promise<void> {
  const client = new pg.Client({ connectionString: env.databaseUrl() });
  client.on("notification", (message) => {
    if (message.channel !== PROGRESS_CHANNEL || !message.payload) return;
    let event: ProgressEvent;
    try {
      event = JSON.parse(message.payload) as ProgressEvent;
    } catch {
      // A malformed payload is a bug in the publisher, not a reason to tear
      // down every open progress stream.
      return;
    }
    for (const subscriber of subscribers.get(event.org_id) ?? []) subscriber(event);
  });
  client.on("error", () => {
    // Losing this connection loses progress updates, not data — the job rows
    // are still authoritative and the UI re-reads them. So: reconnect quietly
    // rather than crashing the API.
    listener = undefined;
    listening = undefined;
    if (!stopped) setTimeout(() => void ensureListening(), 1000);
  });

  await client.connect();
  await client.query(`LISTEN ${pg.escapeIdentifier(PROGRESS_CHANNEL)}`);
  listener = client;
}

function ensureListening(): Promise<void> {
  listening ??= connectListener().catch((err) => {
    listening = undefined;
    throw err;
  });
  return listening;
}

/**
 * Streams `orgId`'s progress events to `handler` until the returned function
 * is called. Opens the shared listener on first use, so a deployment with no
 * SSE clients holds no extra connection.
 */
export async function subscribeProgress(
  orgId: string,
  handler: Subscriber,
): Promise<() => void> {
  await ensureListening();
  let handlers = subscribers.get(orgId);
  if (!handlers) {
    handlers = new Set();
    subscribers.set(orgId, handlers);
  }
  handlers.add(handler);

  return () => {
    handlers.delete(handler);
    if (handlers.size === 0) subscribers.delete(orgId);
  };
}

/**
 * Publishes an event.
 *
 * Takes the caller's transaction rather than reaching for the pool, so a
 * publish inside a request's transaction is delivered when — and only when —
 * that transaction commits. Postgres holds NOTIFY until commit, which is
 * exactly the semantics wanted: no "extraction started" event for an
 * extraction that rolled back.
 *
 * Typed structurally rather than as `Tx` so `apps/worker` (M5) can publish
 * from a plain connection, outside any transaction, without this file
 * growing a second entry point.
 */
export async function publishProgress(
  queryable: { execute: (query: SQL) => Promise<unknown> },
  event: ProgressEvent,
): Promise<void> {
  await queryable.execute(sql`select pg_notify(${PROGRESS_CHANNEL}, ${JSON.stringify(event)})`);
}

/** Closes the shared listener. Used by tests and by graceful shutdown. */
export async function closeProgressListener(): Promise<void> {
  stopped = true;
  subscribers.clear();
  const client = listener;
  listener = undefined;
  listening = undefined;
  await client?.end();
}
