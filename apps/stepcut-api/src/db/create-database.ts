// Creates the `stepcut` database itself, on whatever Postgres server
// `DATABASE_ADMIN_URL` points at.
//
// No coursecut counterpart — `apps/api` never needed this, because its
// database already exists (`infra/postgres/compose.yml`'s `POSTGRES_DB:
// coursecut`, created by the image's own first-boot init). StepCut runs as a
// second database on that same server rather than a second container (plan
// decision 7: "one Postgres server, two databases"), and nothing else creates
// it.
//
// `CREATE DATABASE` cannot run inside a transaction and has no `IF NOT
// EXISTS`, so this can't fold into `bootstrap.ts` — that already connects to
// `stepcut`, and a connection can't create the database it is on. Instead
// this connects to the server's `postgres` maintenance database (derived from
// `DATABASE_ADMIN_URL`) and creates the target database from there.
//
// Idempotent — checks `pg_database` first — so it is safe to run on every
// `db:reset`, in local dev, CI and production alike.
//
//   npm run db:create           # first — then db:bootstrap, then db:migrate

import pg from "pg";
import { env } from "../env.js";

/** Pulls the database name out of a Postgres connection string's path. */
function parseDatabaseName(connectionString: string): string {
  const url = new URL(connectionString);
  const name = url.pathname.replace(/^\//, "");
  if (!name) {
    throw new Error(`DATABASE_ADMIN_URL has no database name: ${connectionString}`);
  }
  return name;
}

/** The same connection string, pointed at `/postgres` instead — the one
 * database guaranteed to exist on any Postgres server, and the only place a
 * `CREATE DATABASE` can be issued from. */
function maintenanceConnectionString(connectionString: string): string {
  const url = new URL(connectionString);
  url.pathname = "/postgres";
  return url.toString();
}

export async function createDatabase(): Promise<void> {
  const adminUrl = env.adminDatabaseUrl();
  const targetName = parseDatabaseName(adminUrl);
  const client = new pg.Client({ connectionString: maintenanceConnectionString(adminUrl) });
  await client.connect();

  try {
    const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      targetName,
    ]);
    if (rowCount === 0) {
      // Not parameterizable — `CREATE DATABASE` takes no bind parameters —
      // so the name is escaped as an identifier instead of interpolated raw.
      await client.query(`CREATE DATABASE ${pg.escapeIdentifier(targetName)}`);
      console.log(`created database ${targetName}`);
    } else {
      console.log(`database ${targetName} already exists`);
    }
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await createDatabase();
}
