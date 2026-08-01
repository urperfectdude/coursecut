// `npm run retention:sweep` — run M7's retention sweep now, from a shell.
//
// The scheduled path is the worker's crontab; this is the operator's. It is
// the same code either way (`src/retention.ts`), which is the point: a
// maintenance job that can only be observed by waiting for 04:20 is a
// maintenance job nobody debugs.
//
// It connects as the **app role**, like the worker does, so the sweep is
// subject to RLS and a bug in it cannot reach across tenants. Running it as
// the admin role would work and would quietly remove that property.

import { closePool } from "../db/client.js";
import { main } from "../retention.js";

await main();
await closePool();
