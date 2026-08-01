// The process. Everything interesting is in `app.ts`; this binds a port and
// shuts down cleanly.
//
//   npm run dev:api      # watch mode on :3000, proxied by Vite at /api
//
// Graceful shutdown matters more here than in a typical API: an SSE stream is
// a long-lived connection, and the LISTEN client behind it is a real Postgres
// session. Dropping them without closing leaks a connection per restart,
// which on a 1 vCPU droplet is noticed.

import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { closePool } from "./db/client.js";
import { env } from "./env.js";
import { closeProgressListener } from "./events.js";

const port = env.port();
const server = serve({ fetch: createApp().fetch, port });

console.log(`api listening on http://localhost:${port} (app origin ${env.appUrl()})`);

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, shutting down`);
  server.close();
  await closeProgressListener();
  await closePool();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
