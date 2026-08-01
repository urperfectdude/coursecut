import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  js.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      "react-hooks": reactHooks,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // TypeScript already catches undefined globals; no-undef false-positives on DOM lib types.
      "no-undef": "off",
    },
  },
  {
    // `apps/` is the web app (docs/web-app-plan.md §2) — it has its own
    // eslint config, its own dependencies, and its own CI job. Linting it
    // from here would run these rules against a tree they don't describe,
    // starting with its build output.
    ignores: ["dist/", "src-tauri/", "node_modules/", "apps/"],
  },
];
