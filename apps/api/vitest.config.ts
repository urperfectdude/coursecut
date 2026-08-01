// Explicit, and load-bearing rather than boilerplate.
//
// Without a config file here, Vitest searches upward and finds the **desktop
// app's** `vite.config.ts` at the repo root — React plugin, Tauri settings and
// all. Plan §0 is unambiguous that nothing under `apps/` may reach into the
// desktop tree, and a test run that silently compiles itself through the
// desktop build config is exactly that, with the added charm of coupling the
// API's tests to a file the desktop release pipeline owns.
//
// `root` pins resolution to this package so the search never starts.

import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ["test/**/*.test.ts"],
    // These talk to a real Postgres. Running files in parallel against one
    // seeded database would have them truncating each other's rows mid-run;
    // the isolation being tested is between tenants, not between test files.
    fileParallelism: false,
    // A connection refused because nobody started the database should say so
    // quickly, not sit in vitest's default timeout.
    testTimeout: 15_000,
    hookTimeout: 30_000,
    env: {
      // `contract.test.ts` imports `apps/web/src/db.ts` and drives the real
      // client. That file reaches the network through `apps/web/src/api`,
      // which picks the in-memory mock whenever it thinks it is in dev — and
      // under Vitest `import.meta.env.DEV` is true. Without this the suite
      // would test the mock against itself and pass for the wrong reason.
      VITE_API_MODE: "live",

      // No test may reach the real OpenAI. `pipeline.test.ts` points this at
      // its own stub; everything else gets an address nothing listens on, so a
      // model call that slips into a test fails in a second instead of
      // spending money against whatever key happens to be in `apps/api/.env`.
      // (This is not hypothetical: the M3 test that asserted the segment-edit
      // route's 501 kept running after M5 implemented it, and reached the live
      // API before it was rewritten.)
      OPENAI_BASE_URL: "http://127.0.0.1:1/v1",
      OPENAI_API_KEY: "sk-test-not-a-real-key",
    },
  },
});
