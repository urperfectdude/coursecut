// `npm run org:purge -- <org-id>` — delete a tenant and everything it holds.
//
// The product path for this is the owner's own "delete this organization" in
// Usage & limits, which goes through `better-auth` and the hook in `auth.ts`.
// This is the operator's path, for the cases that never reach a logged-in
// owner: an abandoned tenant, a support request from someone who cannot sign
// in, a spam signup.
//
// **Objects first, rows second.** The row is what makes the objects findable —
// delete it first and the bucket prefix is left with nothing pointing at it and
// nothing that will ever collect it, because the retention sweep walks orgs
// that exist. Doing it in this order means a failure part-way leaves an org
// with no files, which the sweep and a re-run both handle, rather than files
// with no org, which nothing does.
//
// Irreversible, and deliberately awkward: it asks for the org id twice.

import { getDb, closePool } from "../db/client.js";
import { organizations } from "../db/schema.js";
import { eq } from "drizzle-orm";
import * as storage from "../storage.js";

const [orgId, confirmation] = process.argv.slice(2);

if (!orgId || confirmation !== orgId) {
  console.error(
    "usage: npm run org:purge -- <org-id> <org-id>\n" +
      "       (the id twice — this deletes every project, video, transcript,\n" +
      "        lesson, export and object belonging to that organization)",
  );
  process.exit(2);
}

const [org] = await getDb()
  .select({ id: organizations.id, slug: organizations.slug })
  .from(organizations)
  .where(eq(organizations.id, orgId))
  .limit(1);

if (!org) {
  console.error(`no organization ${orgId}`);
  process.exit(1);
}

const objects = await storage.deletePrefix(`${org.id}/`);
console.log(`purged ${objects} object(s) under ${org.id}/`);

// Projects, videos, transcripts, lessons, exports, jobs, settings and the
// usage ledger all cascade from this row.
await getDb().delete(organizations).where(eq(organizations.id, org.id));
console.log(`deleted organization ${org.slug} (${org.id})`);

await closePool();
