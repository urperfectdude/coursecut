// Applies every pending migration in `apps/api/drizzle/`, as the admin role.
//
// Migrations create tables and policies, so they run as the privileged role,
// never as the role that serves requests (see `src/env.ts`). A separate
// connection is opened here rather than reusing `client.ts`'s pool for
// exactly that reason — the pool is wired to `DATABASE_URL`, and it would be
// far too easy to migrate with it by accident.

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as runMigrations } from "drizzle-orm/node-postgres/migrator";
import { runMigrations as runQueueMigrations } from "graphile-worker";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { env } from "../env.js";
import { regrant } from "./bootstrap.js";

export async function migrate(): Promise<void> {
  const client = new pg.Client({ connectionString: env.adminDatabaseUrl() });
  await client.connect();
  try {
    await runMigrations(drizzle(client), {
      migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
    });
  } finally {
    await client.end();
  }

  // The queue's own schema (M5). It is installed here, as the admin role,
  // rather than by the worker on boot, for the same reason the drizzle
  // migrations are: the roles that run at runtime have no DDL rights, and
  // giving the worker them would make it the one process able to drop a
  // policy. `graphile-worker` checks its migration table at startup and, when
  // it is already current, does nothing further — so the worker still boots
  // fine as the unprivileged role.
  await runQueueMigrations({ connectionString: env.adminDatabaseUrl() });
  // A migration that adds a table leaves the app role without privileges on
  // it unless the default-privileges grant was already in place when the
  // table was created. Re-granting here makes the ordering irrelevant.
  await regrant();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await migrate();
  console.log("migrations applied");
}
