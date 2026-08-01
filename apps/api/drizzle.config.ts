// drizzle-kit generates DDL by diffing `schema.ts` against the migrations it
// has already emitted — it never touches the database to do it, so this
// config's credentials are only used by `drizzle-kit studio`/`push`.
//
// Generation runs as the **admin** role for the same reason migration does:
// creating tables, policies and indexes is not something the request-serving
// role is allowed to do (see `src/env.ts`).

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5432/coursecut",
  },
  // A safety net, not load-bearing: every column in `schema.ts` is named
  // explicitly, so this only decides what a future column that forgets to
  // would be called. snake_case is the convention inherited from desktop.
  casing: "snake_case",
  verbose: true,
  strict: true,
});
