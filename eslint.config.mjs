import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/*.cjs", "**/*.mjs"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["apps/server/src/**/*.ts", "apps/web/src/**/*.ts", "apps/web/src/**/*.tsx", "packages/shared/src/**/*.ts"],
    rules: {
      "prefer-const": ["error", { "ignoreReadBeforeAssign": true }],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_", "destructuredArrayIgnorePattern": "^_" }],
    },
  },
);
