import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

// Mirrors apps/worker's config. Kept separate rather than shared, since each
// app under `apps/` installs its own dependencies — a shared config file
// would be resolved against a plugin this package may not have installed.
export default [
  js.configs.recommended,
  {
    files: ["src/**/*.ts"],
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
    },
  },
  {
    ignores: ["node_modules/", "dist/"],
  },
];
