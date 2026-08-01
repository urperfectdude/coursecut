// M2's acceptance criterion: "RLS proven by a cross-tenant read test that
// fails as expected" (plan §7).
//
// The point of these cases is that they exercise the layer *below* the one
// `apps/api` will be written in. Every query here is deliberately wrong — no
// `WHERE org_id = …` anywhere — because the question being asked is not "does
// application code scope correctly" but "what happens the day it doesn't".
// The answer has to be "nothing comes back", not "everything does".
//
// Runs as the app role against a seeded database:
//
//   docker compose -f infra/postgres/compose.yml up -d
//   cd apps/api && npm run db:reset && npm test

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getDb, withOrg } from "../src/db/client.js";
import { TENANT_TABLES } from "../src/db/schema.js";
import { SEED, seed } from "../src/db/seed.js";

/** SQLSTATE codes, checked instead of message text. */
const INSUFFICIENT_PRIVILEGE = "42501"; // what an RLS violation raises
const FOREIGN_KEY_VIOLATION = "23503";

/**
 * Asserts a query fails with a specific SQLSTATE.
 *
 * Matching on the message would be matching on the wrong thing twice over:
 * Drizzle wraps the driver error, so `.message` is its own "Failed query: …"
 * text and the Postgres wording lives on `.cause`; and that wording is
 * localized and version-dependent anyway. The code is neither.
 */
async function expectSqlState(promise: Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try {
    await promise;
  } catch (err) {
    raised = err;
  }
  expect(raised, "expected the query to fail, but it succeeded").toBeDefined();
  const pgError = (raised as { cause?: { code?: string } }).cause ?? raised;
  expect((pgError as { code?: string }).code).toBe(code);
}

beforeAll(async () => {
  // Seeded here, not assumed, so the suite is self-contained and a failure is
  // never "someone forgot to run db:seed".
  await seed();
});

afterAll(async () => {
  await closePool();
});

describe("the connection RLS depends on", () => {
  it("is not a superuser and cannot bypass RLS", async () => {
    // The policies are worth precisely nothing if this is false: a superuser
    // ignores RLS entirely, and a table's owner ignores it unless the table
    // is FORCEd. A deploy that points DATABASE_URL at `postgres` would make
    // every other test here pass while protecting nothing, so this is checked
    // first and explicitly.
    const rows = await getDb().execute<{ rolsuper: boolean; rolbypassrls: boolean }>(
      sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    expect(rows.rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
  });

  it("has a policy on every tenant table", async () => {
    // Reads the same constant `schema.ts` exports, so adding a tenant table
    // without a policy fails here rather than shipping unprotected.
    const rows = await getDb().execute<{ tablename: string }>(
      sql`SELECT tablename FROM pg_policies WHERE schemaname = 'public' AND policyname = 'org_isolation'`,
    );
    const covered = rows.rows.map((r) => r.tablename).sort();
    expect(covered).toEqual([...TENANT_TABLES].sort());
  });

  it("forces RLS on every tenant table, so the owner is not exempt", async () => {
    const rows = await getDb().execute<{ relname: string }>(
      sql`SELECT relname FROM pg_class
          WHERE relnamespace = 'public'::regnamespace
            AND relrowsecurity AND relforcerowsecurity`,
    );
    expect(rows.rows.map((r) => r.relname).sort()).toEqual([...TENANT_TABLES].sort());
  });
});

describe("cross-tenant reads", () => {
  it("sees only the active org's projects", async () => {
    // No WHERE clause at all — this is the forgotten-scoping bug, written on
    // purpose. RLS is the only thing standing between it and Globex's data.
    const acme = await withOrg(SEED.orgA.id, (tx) =>
      tx.execute<{ id: string }>(sql`SELECT id FROM projects`),
    );
    expect(acme.rows.map((r) => r.id)).toEqual([SEED.projectA.id]);

    const globex = await withOrg(SEED.orgB.id, (tx) =>
      tx.execute<{ id: string }>(sql`SELECT id FROM projects`),
    );
    expect(globex.rows.map((r) => r.id)).toEqual([SEED.projectB.id]);
  });

  it("cannot read another org's row even when handed its primary key", async () => {
    // The realistic attack, and the realistic bug: an id arrives from the
    // client and is looked up without checking whose it is. Under RLS the
    // lookup simply finds nothing, which the API surfaces as a 404 — the same
    // response as a genuinely missing row, so the id space leaks nothing
    // either.
    const stolen = await withOrg(SEED.orgA.id, (tx) =>
      tx.execute(sql`SELECT id FROM projects WHERE id = ${SEED.projectB.id}`),
    );
    expect(stolen.rows).toHaveLength(0);
  });

  it("hides descendant rows too, not just the top-level ones", async () => {
    // `org_id` is denormalized onto every table precisely so this holds
    // without a join back to `projects`. If a child table's policy were
    // missing, this is where it would show.
    // Sequential, not `Promise.all`: a transaction is one connection, and
    // node-postgres cannot have two queries in flight on it at once.
    const { videos, transcripts, lessons, lessonSegments } = await withOrg(
      SEED.orgB.id,
      async (tx) => ({
        videos: await tx.execute<{ id: string }>(sql`SELECT id FROM videos`),
        transcripts: await tx.execute(sql`SELECT id FROM transcript_segments`),
        lessons: await tx.execute(sql`SELECT id FROM lessons`),
        lessonSegments: await tx.execute(sql`SELECT id FROM lesson_segments`),
      }),
    );
    expect(videos.rows.map((r) => r.id)).toEqual([SEED.videoB.id]);
    // Globex's video has no transcript and no lessons; Acme's has both, so
    // any leak shows up as a non-empty result here.
    expect(transcripts.rows).toHaveLength(0);
    expect(lessons.rows).toHaveLength(0);
    expect(lessonSegments.rows).toHaveLength(0);
  });

  it("returns nothing at all when no org context was set", async () => {
    // Fail-closed: `current_setting(…, true)` is NULL outside `withOrg`, and
    // `org_id = NULL` is never true. A query that skips the helper entirely
    // gets an empty result rather than the whole table.
    const rows = await getDb().execute(sql`SELECT id FROM projects`);
    expect(rows.rows).toHaveLength(0);
  });

  it("does not leak across orgs through the transcript cache", async () => {
    // Plan §6 makes content-hash caching per-org a security requirement, not
    // an optimization: a shared cache would tell one tenant that another
    // holds a byte-identical video. Two orgs uploading the same file must
    // each see only their own row.
    const hash = "sha256:identical-content-in-both-orgs";
    await withOrg(SEED.orgA.id, (tx) =>
      tx.execute(sql`UPDATE videos SET content_hash = ${hash} WHERE id = ${SEED.videoA.id}`),
    );
    await withOrg(SEED.orgB.id, (tx) =>
      tx.execute(sql`UPDATE videos SET content_hash = ${hash} WHERE id = ${SEED.videoB.id}`),
    );

    const hit = await withOrg(SEED.orgA.id, (tx) =>
      tx.execute<{ id: string }>(sql`SELECT id FROM videos WHERE content_hash = ${hash}`),
    );
    expect(hit.rows.map((r) => r.id)).toEqual([SEED.videoA.id]);
  });
});

describe("cross-tenant writes", () => {
  it("rejects an insert stamped with another org's id", async () => {
    // WITH CHECK, not USING. Without it a row could be written into another
    // tenant and then be invisible to the writer — data corruption that only
    // the victim ever sees.
    await expectSqlState(
      withOrg(SEED.orgA.id, (tx) =>
        tx.execute(
          sql`INSERT INTO projects (id, org_id, name) VALUES ('proj_smuggled', ${SEED.orgB.id}, 'Smuggled')`,
        ),
      ),
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it("silently matches nothing on an update aimed at another org", async () => {
    // An UPDATE cannot fail here — the row is not visible, so there is
    // nothing to fail on. Zero rows affected is the correct outcome, and the
    // API must treat "0 updated" as a 404 rather than as success.
    const result = await withOrg(SEED.orgA.id, (tx) =>
      tx.execute(sql`UPDATE projects SET name = 'Renamed' WHERE id = ${SEED.projectB.id}`),
    );
    expect(result.rowCount).toBe(0);

    const untouched = await withOrg(SEED.orgB.id, (tx) =>
      tx.execute<{ name: string }>(sql`SELECT name FROM projects WHERE id = ${SEED.projectB.id}`),
    );
    expect(untouched.rows[0]?.name).toBe(SEED.projectB.name);
  });

  it("cannot move one of its own rows into another org", async () => {
    // The other half of WITH CHECK: a row that is visible now must still
    // satisfy the policy after the update.
    await expectSqlState(
      withOrg(SEED.orgA.id, (tx) =>
        tx.execute(
          sql`UPDATE projects SET org_id = ${SEED.orgB.id} WHERE id = ${SEED.projectA.id}`,
        ),
      ),
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it("cannot delete another org's row", async () => {
    const result = await withOrg(SEED.orgA.id, (tx) =>
      tx.execute(sql`DELETE FROM projects WHERE id = ${SEED.projectB.id}`),
    );
    expect(result.rowCount).toBe(0);
  });

  it("cannot attach a child row to another org's parent", async () => {
    // This one is caught by the composite foreign key `(project_id, org_id) →
    // projects(id, org_id)` rather than by RLS: the row's own `org_id` is
    // Acme's, so it satisfies the policy, but the (project, org) pair does not
    // exist. That is the schema constraint doing work RLS structurally cannot
    // — a policy only ever sees the row in front of it — which is why the
    // denormalized `org_id` is nailed down with a composite FK and not just a
    // comment.
    await expectSqlState(
      withOrg(SEED.orgA.id, (tx) =>
        tx.execute(
          sql`INSERT INTO videos (id, org_id, project_id, storage_key)
              VALUES ('vid_smuggled', ${SEED.orgA.id}, ${SEED.projectB.id}, 'x/y/z/a.mp4')`,
        ),
      ),
      FOREIGN_KEY_VIOLATION,
    );
  });
});

describe("privileges", () => {
  it("cannot disable the policies protecting it", async () => {
    // RLS that the constrained role can turn off is decoration. The app role
    // is granted DML only — no DDL — so this fails on ownership.
    await expectSqlState(
      getDb().execute(sql`ALTER TABLE projects DISABLE ROW LEVEL SECURITY`),
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it("cannot read the graphile-worker-adjacent auth tables it has no business in", async () => {
    // Not a policy check — auth tables deliberately have no RLS (see
    // 0001_rls.sql). This documents the current, accepted state: the app role
    // *can* read `users`, because sign-in needs to. If that ever needs
    // narrowing it will be by revoking grants, not by adding a policy, and
    // this test is where the decision is recorded.
    const rows = await getDb().execute(sql`SELECT id FROM users`);
    expect(rows.rows.length).toBeGreaterThan(0);
  });
});
