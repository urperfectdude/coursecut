import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

// Mirrors apps/web's config minus the React rules — kept separate rather than
// shared, since apps/api installs its own dependencies (plan §2).
export default [
  js.configs.recommended,
  {
    files: ["src/**/*.ts", "test/**/*.ts", "*.config.ts"],
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
    ignores: ["node_modules/", "dist/", "drizzle/"],
  },
];
