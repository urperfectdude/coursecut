// Drizzle's query operators, re-exported.
//
// This exists for exactly one reason: `apps/worker` is a separate npm package
// (plan §2 — each app under `apps/` installs its own dependencies) that builds
// queries against **this** package's schema and runs them on **this** package's
// connection. If it imported `drizzle-orm` itself it would get a second copy,
// and a `PgColumn` from one copy is not a `PgColumn` from the other: the types
// carry private members, so the two are nominally distinct and every
// `eq(videos.id, …)` in the worker fails to typecheck against a `tx` from here.
//
// The alternative — no package.json in `apps/worker`, so it borrows this one's
// `node_modules` — is worse, and not just aesthetically: a bare import from a
// file with no package boundary above it walks up to the repo root and finds
// the **desktop app's** `node_modules`, which plan §0 forbids outright.
//
// So the worker takes its operators from here, and there is one drizzle in the
// process. Add to this list as the worker needs more; there is nothing else to
// keep in sync.

export { and, asc, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
