import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

// Mirrors apps/api's config — kept separate rather than shared, since
// stepcut-api installs its own dependencies (own npm project, not a
// workspace member).
export default [
  js.configs.recommended,
  {
    files: ["src/**/*.ts", "*.config.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
    },
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      // TypeScript already catches undefined globals, and `no-undef` false-
      // positives on Node's built-in types.
      "no-undef": "off",
      // A leading underscore marks a parameter kept only for signature
      // compatibility (e.g. `rate-limit.ts`'s `isExpensive`, unwired in
      // Phase 1 — see that file's header). Matches `tsc`'s own
      // `noUnusedParameters` leniency for the same convention.
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  {
    ignores: ["node_modules/", "dist/", "drizzle/"],
  },
];
