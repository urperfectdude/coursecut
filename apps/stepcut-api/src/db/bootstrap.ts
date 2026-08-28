// Creates the least-privilege role that serves requests, and grants it
// exactly what it needs.
//
// Copied from apps/api/src/db/bootstrap.ts. This is the half of the
// isolation model that RLS cannot do for itself: **a policy has no effect on
// a superuser, and none on a table's owner unless the table is FORCEd.**
// Enabling RLS while still connecting as `postgres` produces a database that
// looks protected in `\d` and is not. So the app gets its own role here, and
// a future RLS migration (once `TENANT_TABLES` is non-empty — see
// src/db/schema.ts) FORCEs every policy so even an ownership mistake later
// cannot quietly re-open the door.
//
// Deliberately idempotent, and deliberately not in
// `/docker-entrypoint-initdb.d`: that only runs on a first-boot empty volume,
// which means it never runs in CI (Postgres is a service container there) and
// is skipped for anyone who already has a volume. Running everywhere beats
// running automatically.
//
//   npm run db:create           # first — see src/db/create-database.ts
//   npm run db:bootstrap        # then this, before db:migrate

import pg from "pg";
import { env } from "../env.js";

/**
 * Grants the app role its table privileges.
 *
 * Two passes, because the role is created before the tables exist:
 * `ALTER DEFAULT PRIVILEGES` covers everything migrations will create later,
 * and the explicit grants catch anything already there — which is what makes
 * this safe to re-run against a database that is already migrated.
 *
 * DDL is not granted. The app role can read and write rows; it cannot create,
 * alter or drop a table, and so cannot drop a policy either.
 */
async function grantAppPrivileges(client: pg.Client, appUser: string): Promise<void> {
  const role = pg.escapeIdentifier(appUser);
  const owner = pg.escapeIdentifier(client.user ?? "postgres");

  await client.query(`GRANT CONNECT ON DATABASE ${pg.escapeIdentifier(client.database!)} TO ${role}`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);

  // Future tables, created by migrations running as the admin role.
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public
       GRANT USAGE, SELECT ON SEQUENCES TO ${role}`,
  );

  // Anything that already exists.
  await client.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
  );
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);

  await grantQueuePrivileges(client, appUser, owner);
}

/**
 * The same grants over `graphile_worker`, once it exists.
 *
 * Both runtime processes need it: `apps/stepcut-api` calls `add_job` inside a
 * request transaction, and `apps/stepcut-worker` locks, completes and fails
 * jobs. Neither may be the admin role — a superuser ignores RLS outright,
 * which would quietly undo tenant isolation for the two processes that touch
 * the most tenant data. So the unprivileged role gets working rights on the
 * queue and still no DDL.
 *
 * Skipped silently before the first `db:migrate`, which is when the schema is
 * installed — `bootstrap` runs before `migrate` on a fresh database, and
 * `migrate` calls `regrant` afterwards, so the grants land either way.
 *
 * These tables carry no `org_id`. That is not a hole: a queue entry holds a
 * job id and an org id in its payload, and every handler resolves that
 * through `withOrg` before reading a single tenant row. The queue schedules
 * work; it never answers questions about tenant data.
 */
async function grantQueuePrivileges(client: pg.Client, appUser: string, owner: string): Promise<void> {
  const role = pg.escapeIdentifier(appUser);
  const { rowCount } = await client.query(
    "SELECT 1 FROM information_schema.schemata WHERE schema_name = 'graphile_worker'",
  );
  if (rowCount === 0) return;

  await client.query(`GRANT USAGE ON SCHEMA graphile_worker TO ${role}`);
  await client.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA graphile_worker TO ${role}`,
  );
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA graphile_worker TO ${role}`);
  await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA graphile_worker TO ${role}`);

  // `graphile-worker` turns RLS **on** for its private tables and writes no
  // policies at all. That is not an oversight on its part: it expects the
  // process using the queue to connect as the role that owns those tables, and
  // a table's owner is exempt from RLS unless the table is FORCEd. Its own
  // tables are not, so the owner sails through and everyone else is refused.
  //
  // We connect as neither: migrations run as admin (which owns them) and both
  // runtime processes are the unprivileged role, on purpose — see this
  // function's own doc. So the grants above are not enough by themselves, and
  // an `add_job` from a request fails with "new row violates row-level
  // security policy". The policy below is what closes that.
  //
  // Permissive, and that is the right shape here. These tables hold a task
  // name, a payload and a schedule; they are not tenant data and have no
  // `org_id` to scope by. The isolation that matters happens one layer down:
  // a handler takes the org id out of the payload and goes through `withOrg`,
  // where a future tenant table's policies decide what it can actually see.
  // Scoping the queue itself would protect nothing and break `add_job`.
  //
  // Driven off `pg_class` rather than a list of table names, so a future
  // `graphile-worker` migration that adds one is covered by re-running this
  // rather than by someone remembering.
  await client.query(
    `DO $$
     DECLARE target regclass;
     BEGIN
       FOR target IN
         SELECT c.oid::regclass
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'graphile_worker' AND c.relkind = 'r' AND c.relrowsecurity
       LOOP
         IF NOT EXISTS (
           SELECT 1 FROM pg_policy WHERE polrelid = target AND polname = 'stepcut_app_all'
         ) THEN
           EXECUTE format(
             'CREATE POLICY stepcut_app_all ON %s FOR ALL TO %I USING (true) WITH CHECK (true)',
             target, ${pg.escapeLiteral(appUser)}
           );
         END IF;
       END LOOP;
     END $$`,
  );

  // A future queue migration adds tables and functions; without these the app
  // role would lose access to them until someone re-ran the bootstrap by hand.
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA graphile_worker
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA graphile_worker
       GRANT EXECUTE ON FUNCTIONS TO ${role}`,
  );
}

export async function bootstrap(): Promise<void> {
  const appUser = env.appDbUser();
  const appPassword = env.appDbPassword();

  const client = new pg.Client({ connectionString: env.adminDatabaseUrl() });
  await client.connect();

  try {
    const role = pg.escapeIdentifier(appUser);
    const password = pg.escapeLiteral(appPassword);

    // NOSUPERUSER/NOBYPASSRLS/NOCREATEDB/NOCREATEROLE are all defaults; they
    // are spelled out because every one of them being false is what makes a
    // future policy mean anything.
    const attributes = `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${password}`;
    const { rowCount } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [appUser]);
    if (rowCount === 0) {
      await client.query(`CREATE ROLE ${role} ${attributes}`);
      console.log(`created role ${appUser}`);
    } else {
      // Re-assert the attributes rather than assuming: a role that picked up
      // BYPASSRLS by hand at some point is exactly the failure this file is
      // here to prevent, and it is invisible until a tenant leak.
      await client.query(`ALTER ROLE ${role} ${attributes}`);
      console.log(`updated role ${appUser}`);
    }

    // Postgres 15+ already revokes this from PUBLIC; older servers do not,
    // and a role that can CREATE in `public` can shadow a table.
    await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");

    await grantAppPrivileges(client, appUser);
    console.log(`granted table privileges to ${appUser}`);
  } finally {
    await client.end();
  }
}

// Re-grant after migrations, so a migration that adds a table to an already
// bootstrapped database does not leave the app role unable to read it.
export async function regrant(): Promise<void> {
  const client = new pg.Client({ connectionString: env.adminDatabaseUrl() });
  await client.connect();
  try {
    await grantAppPrivileges(client, env.appDbUser());
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await bootstrap();
}
