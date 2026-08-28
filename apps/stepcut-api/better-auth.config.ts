// Exists only so `npx @better-auth/cli generate` has something to read.
//
// The CLI insists on a module that exports a *built* auth instance under the
// name `auth`; `src/auth.ts` deliberately exports a factory instead, so that
// importing it never reads the environment or opens a pool. This file bridges
// the two and is not imported by any running code.
//
//   npm run auth:generate      # prints the schema better-auth expects
//
// The output is the authority on the seven auth tables in `src/db/schema.ts`
// (see that file's header). Reconcile by hand rather than applying it: our
// tables are named and cased to this codebase's conventions, and the mapping
// that reconciles the two lives in `src/auth.ts`.

import { getAuth } from "./src/auth.js";

export const auth = getAuth();
