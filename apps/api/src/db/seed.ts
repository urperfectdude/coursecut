// Local development data (plan §5).
//
// Two orgs, not one. A single-org seed makes tenant isolation untestable —
// there is nothing to leak — and plan §5 calls this out specifically: seed a
// second org "so tenant-isolation tests have something to fail against".
// `test/tenant-isolation.test.ts` is that test, and it seeds through this
// module rather than duplicating fixtures.
//
// Runs as the **admin** role. That is a superuser, so RLS does not apply to
// it, which is exactly what a seed needs: it writes across both orgs in one
// pass. It is also why nothing else may ever connect this way — see
// `src/env.ts`.
//
//   npm run db:seed
//
// Idempotent by truncation: every run drops the domain rows and rewrites
// them, so a re-seed after a schema change is one command rather than a
// volume delete.

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { getAuth } from "../auth.js";
import { env } from "../env.js";
import * as schema from "./schema.js";

/**
 * The password both seeded users sign in with. Dev-only, and only ever
 * reaches the database as a `better-auth` hash (see `credentialAccount`) —
 * the plaintext exists here so `npm run dev:api` is usable and the contract
 * tests have something to authenticate with, not because it is stored.
 */
export const SEED_PASSWORD = "coursecut-dev-password";

/** Stable ids so a re-seed leaves URLs, bookmarks and test fixtures valid. */
export const SEED = {
  orgA: { id: "org_acme", name: "Acme University", slug: "acme" },
  orgB: { id: "org_globex", name: "Globex Institute", slug: "globex" },
  userA: { id: "user_ada", name: "Ada Lovelace", email: "ada@example.com" },
  userB: { id: "user_grace", name: "Grace Hopper", email: "grace@example.com" },
  projectA: { id: "proj_acme_intro", name: "Intro to Databases" },
  projectB: { id: "proj_globex_ml", name: "Machine Learning 101" },
  videoA: { id: "vid_acme_week1" },
  videoB: { id: "vid_globex_week1" },
  lessonA: { id: "lesson_acme_1" },
} as const;

/**
 * Storage keys are `{org}/{project}/{video}/{filename}` — plan §3.4 rule 1.
 * Never a URL, never a bucket hostname: the org prefix is what makes an
 * object-store listing tenant-scoped the same way RLS makes a table scan one.
 */
function storageKey(orgId: string, projectId: string, videoId: string, filename: string): string {
  return `${orgId}/${projectId}/${videoId}/${filename}`;
}

/**
 * A credentials row for `userId`, with the password hashed **by
 * `better-auth`** rather than by us.
 *
 * M2 left these out on the grounds that inventing a hash the library might
 * not recognise would be worse than having none. That reasoning still holds —
 * what changed is that the library is now here to ask. `auth.$context`
 * exposes the same hasher the sign-up route uses, so a seeded account is
 * indistinguishable from a registered one, and this file still contains no
 * crypto of its own.
 *
 * `accountId` is the user's own id and `providerId` is `"credential"`, which
 * is `better-auth`'s convention for email+password (as opposed to an OAuth
 * provider, where `accountId` would be the provider's id for the user).
 */
async function credentialAccount(userId: string, password: string) {
  const ctx = await getAuth().$context;
  return {
    id: `acct_${userId}`,
    userId,
    accountId: userId,
    providerId: "credential",
    password: await ctx.password.hash(password),
  };
}

export async function seed(): Promise<void> {
  const client = new pg.Client({ connectionString: env.adminDatabaseUrl() });
  await client.connect();
  const db = drizzle(client, { schema });

  try {
    // CASCADE reaches videos → transcript_segments/lessons → lesson_segments
    // → exports, and jobs through both. RESTART IDENTITY is not needed (every
    // id is application-generated text) but is harmless and future-proof.
    await db.execute(
      sql`TRUNCATE TABLE organizations, users RESTART IDENTITY CASCADE`,
    );

    await db.insert(schema.organizations).values([
      { id: SEED.orgA.id, name: SEED.orgA.name, slug: SEED.orgA.slug },
      { id: SEED.orgB.id, name: SEED.orgB.name, slug: SEED.orgB.slug },
    ]);

    await db.insert(schema.users).values([
      { id: SEED.userA.id, name: SEED.userA.name, email: SEED.userA.email, emailVerified: true },
      { id: SEED.userB.id, name: SEED.userB.name, email: SEED.userB.email, emailVerified: true },
    ]);

    // Both users share `SEED_PASSWORD`, so `npm run dev:api` is signed into
    // with a credential that exists rather than one that has to be created
    // first. M3's addition — M2 had no library to hash with.
    await db.insert(schema.accounts).values([
      await credentialAccount(SEED.userA.id, SEED_PASSWORD),
      await credentialAccount(SEED.userB.id, SEED_PASSWORD),
    ]);

    await db.insert(schema.members).values([
      { id: "mem_ada_acme", organizationId: SEED.orgA.id, userId: SEED.userA.id, role: "owner" },
      { id: "mem_grace_globex", organizationId: SEED.orgB.id, userId: SEED.userB.id, role: "owner" },
      // Ada is in both orgs, so the org switcher (§4.1) has something to
      // switch between. A single-org user must still see the desktop UI with
      // no extra chrome, which is only checkable if someone is not one.
      { id: "mem_ada_globex", organizationId: SEED.orgB.id, userId: SEED.userA.id, role: "member" },
    ]);

    await db.insert(schema.projects).values([
      { id: SEED.projectA.id, orgId: SEED.orgA.id, name: SEED.projectA.name },
      { id: SEED.projectB.id, orgId: SEED.orgB.id, name: SEED.projectB.name },
    ]);

    // `upload_status: 'uploaded'` without an object actually in MinIO — these
    // rows exist so the UI has something to render, not so playback works.
    // Anything that needs real bytes needs a real upload (M3).
    await db.insert(schema.videos).values([
      {
        id: SEED.videoA.id,
        orgId: SEED.orgA.id,
        projectId: SEED.projectA.id,
        storageKey: storageKey(SEED.orgA.id, SEED.projectA.id, SEED.videoA.id, "week-1-lecture.mp4"),
        uploadStatus: "uploaded",
        duration: 3600,
        transcriptStatus: "transcribed",
      },
      {
        id: SEED.videoB.id,
        orgId: SEED.orgB.id,
        projectId: SEED.projectB.id,
        storageKey: storageKey(SEED.orgB.id, SEED.projectB.id, SEED.videoB.id, "week-1-lecture.mp4"),
        uploadStatus: "uploaded",
        duration: 2700,
        transcriptStatus: "pending",
      },
    ]);

    await db.insert(schema.transcriptSegments).values([
      {
        id: "seg_acme_1",
        orgId: SEED.orgA.id,
        videoId: SEED.videoA.id,
        start: 0,
        end: 12.5,
        text: "Good morning. Today we are going to talk about relational databases.",
        keep: true,
      },
      {
        id: "seg_acme_2",
        orgId: SEED.orgA.id,
        videoId: SEED.videoA.id,
        start: 12.5,
        end: 31,
        text: "Before we start, a quick reminder that the assignment is due Friday.",
        // Dropped in Transcript Mode — the state PRD §8.1's editing produces.
        keep: false,
      },
      {
        id: "seg_acme_3",
        orgId: SEED.orgA.id,
        videoId: SEED.videoA.id,
        start: 31,
        end: 58.25,
        text: "A relation is, formally, a set of tuples over a set of attributes.",
        keep: true,
      },
    ]);

    // start/end are the cached bound across the lesson's segments (0006), so
    // they are written to match the two segments below rather than chosen.
    await db.insert(schema.lessons).values({
      id: SEED.lessonA.id,
      orgId: SEED.orgA.id,
      videoId: SEED.videoA.id,
      title: "What is a relation?",
      summary: "Defines relations, tuples and attributes, with a worked example.",
      start: 0,
      end: 58.25,
      sortOrder: 0,
      confidence: 0.92,
      kind: "lesson",
      source: "ai",
    });

    // Non-contiguous on purpose: it skips the assignment reminder in the
    // middle, which is the multi-segment case 0006 exists for and the one the
    // segment scrubber has to render correctly.
    await db.insert(schema.lessonSegments).values([
      { id: "lseg_acme_1", orgId: SEED.orgA.id, lessonId: SEED.lessonA.id, start: 0, end: 12.5, sortOrder: 0 },
      { id: "lseg_acme_2", orgId: SEED.orgA.id, lessonId: SEED.lessonA.id, start: 31, end: 58.25, sortOrder: 1 },
    ]);

    // No OpenAI key anywhere in here — the platform holds one key in the
    // server environment (D7), so there is nothing per-org to seed.
    await db.insert(schema.orgSettings).values([
      { orgId: SEED.orgA.id, analysisInstructions: "Prefer shorter lessons; split at topic changes." },
      { orgId: SEED.orgB.id },
    ]);

    console.log(
      `seeded ${SEED.orgA.slug} (1 project, 1 video, 1 lesson) and ${SEED.orgB.slug} (1 project, 1 video)`,
    );
    console.log(`sign in as ${SEED.userA.email} / ${SEED_PASSWORD}`);
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await seed();
}
