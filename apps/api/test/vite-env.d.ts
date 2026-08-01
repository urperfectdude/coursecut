// The Vite environment the copied web client compiles against, declared here
// rather than pulled in with `/// <reference types="vite/client" />`.
//
// `contract.test.ts` imports `apps/web/src/db.ts` — the real shipped client —
// and two files under it read `import.meta.env`. The triple-slash reference
// those tests used to carry resolved `vite` through `apps/web/node_modules`,
// which exists on a developer's machine and does not in CI: the api job
// installs `apps/api` only, so the typecheck failed there and nowhere else.
//
// Declaring the three keys the web client actually reads keeps this package's
// typecheck self-contained. `apps/web` still references `vite/client` for
// real (`src/vite-env.d.ts`), where Vite is a dependency and the full surface
// is wanted.
interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly VITE_API_MODE?: string;
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
