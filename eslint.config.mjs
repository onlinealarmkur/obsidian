import eslint from "@eslint/js";
import globals from "globals";
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["main.js", "node_modules/", "coverage/", "types/**/*.d.ts"] },
  eslint.configs.recommended,
  ...obsidianmd.configs.recommended,
  ...tseslint.configs.strictTypeChecked.map((config) => ({ ...config, files: ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts"] })),
  ...tseslint.configs.stylisticTypeChecked.map((config) => ({ ...config, files: ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts"] })),
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
    },
    rules: {
      "@typescript-eslint/consistent-type-definitions": ["error", "interface"],
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-magic-numbers": "off",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { "allowNumber": true }]
    }
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      globals: { ...globals.browser }
    },
    rules: {
      // Preserve the required product heading while keeping all other UI strings checked.
      "obsidianmd/ui/sentence-case": ["warn", { ignoreRegex: ["Alarm and Timer"] }]
    }
  },
  {
    files: ["tests/**/*.ts"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node }
    }
  },
  {
    files: ["vitest.config.ts"],
    languageOptions: {
      globals: { ...globals.node }
    }
  },
  {
    files: ["esbuild.config.mjs", "scripts/**/*.mjs", "tests/**/*.{ts,mjs}", "vitest.config.ts"],
    rules: {
      // These files execute only in Node test/build tooling, never inside Obsidian.
      "obsidianmd/no-nodejs-modules": "off",
      // Disposable-vault tests intentionally exercise an explicit .obsidian fixture path.
      "obsidianmd/hardcoded-config-path": "off",
      // Test globals and DOM mocks do not execute in an Obsidian window or popout.
      "obsidianmd/no-global-this": "off",
      "obsidianmd/prefer-create-el": "off"
    }
  }
);
