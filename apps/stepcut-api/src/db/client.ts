// The database handle, and the one function that is allowed to run a
// tenant-scoped query.
//
// Copied verbatim from apps/api/src/db/client.ts — pure mechanism, and
// exactly what a later phase's RLS-covered tables will be scoped through.
// `TENANT_TABLES` is empty in Phase 1 (see src/db/schema.ts), so nothing
// calls `withOrg` yet, but the mechanism itself does not change when that
// stops being true.
//
// Query outside `withOrg` and you do not get more rows, you get none: a
// future policy compares against `current_setting('app.current_org_id',
// true)`, which is NULL when unset, and `org_id = NULL` is never true.
// Forgetting to scope fails closed, which is the only direction worth
// failing in.

import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";
import { env } from "../env.js";
import * as schema from "./schema.js";

// `double precision` (OID 701) arrives as a JS string by default, because
// node-postgres cannot know whether the value fits. None of Phase 1's columns
// are `double precision`, but this stays here so a later phase's tables (cut
// timestamps, confidence scores) do not silently regress to strings.
pg.types.setTypeParser(pg.types.builtins.FLOAT8, Number.parseFloat);

let pool: pg.Pool | undefined;

/** Lazily-built pool, so importing this module never opens a connection. */
export function getPool(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: env.databaseUrl() });
  return pool;
}

export function getDb() {
  return drizzle(getPool(), { schema });
}

export type Db = ReturnType<typeof getDb>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Runs `fn` in a transaction scoped to `orgId`. Every tenant-table read and
 * write must go through this once a tenant table exists.
 *
 * `set_config(..., true)` is `SET LOCAL` — the setting is reverted when the
 * transaction ends, so a pooled connection can never carry one request's org
 * into the next one's. It is used in preference to the literal `SET LOCAL`
 * statement because `SET LOCAL` takes no bind parameters: scoping would mean
 * interpolating a tenant id into SQL text, which is exactly the kind of
 * string-building this whole mechanism exists to survive.
 */
export async function withOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!orgId) throw new Error("withOrg requires an org id");
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
