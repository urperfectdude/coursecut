// The process. Everything interesting is in `app.ts`; this binds a port and
// shuts down cleanly.
//
//   npm run dev      # watch mode on :3001, proxied by apps/stepcut's Vite at /api

import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { closePool } from "./db/client.js";
import { env } from "./env.js";

const port = env.port();
const server = serve({ fetch: createApp().fetch, port });

console.log(`stepcut-api listening on http://localhost:${port} (app origin ${env.appUrl()})`);

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, shutting down`);
  server.close();
  await closePool();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
