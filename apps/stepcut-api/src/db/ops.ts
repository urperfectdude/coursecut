// Drizzle's query operators, re-exported.
//
// Copied from apps/api/src/db/ops.ts. This exists for exactly one reason:
// `apps/stepcut-worker` is a separate npm package with its own `node_modules`
// and no `drizzle-orm` of its own — it builds queries against **this**
// package's schema and runs them on **this** package's connection. If it
// imported `drizzle-orm` itself it would get a second copy, and a `PgColumn`
// from one copy is not a `PgColumn` from the other: the types carry private
// members, so the two are nominally distinct and every `eq(videos.id, …)` in
// the worker would fail to typecheck against a `tx` from here.
//
// So the worker takes its operators from here, and there is one drizzle in
// the process. Add to this list as the worker needs more; there is nothing
// else to keep in sync.

export { and, eq, isNotNull, ne, sql } from "drizzle-orm";
