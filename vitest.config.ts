import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("./tests/mocks/obsidian.ts", import.meta.url))
    }
  },
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["**/*.d.ts", "**/node_modules/**", "**/coverage/**", "**/main.js"],
      reporter: ["text", "json"],
      thresholds: {
        "src/main.ts": { statements: 80, branches: 50, functions: 70, lines: 90 },
        "src/i18n/index.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
        "src/data/data-store.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/data/migrations.ts": { statements: 90, branches: 80, functions: 90, lines: 95 },
        "src/data/validation.ts": { statements: 90, branches: 85, functions: 95, lines: 95 },
        "src/services/alert-service.ts": { statements: 85, branches: 70, functions: 85, lines: 90 },
        "src/services/audio-service.ts": { statements: 85, branches: 80, functions: 80, lines: 90 },
        "src/services/item-service.ts": { statements: 90, branches: 65, functions: 95, lines: 95 },
        "src/services/scheduler-logic.ts": { statements: 90, branches: 80, functions: 95, lines: 95 },
        "src/services/scheduler.ts": { statements: 90, branches: 85, functions: 90, lines: 95 },
        "src/ui/alarm-timer-view.ts": { statements: 85, branches: 70, functions: 60, lines: 90 },
        "src/ui/alert-modal.ts": { statements: 85, branches: 55, functions: 80, lines: 90 },
        "src/ui/forms.ts": { statements: 85, branches: 50, functions: 85, lines: 85 },
        "src/ui/settings-tab.ts": { statements: 85, branches: 65, functions: 95, lines: 85 },
        "src/ui/status-bar-controller.ts": { statements: 95, branches: 80, functions: 95, lines: 95 },
        "src/utils/date-time.ts": { statements: 85, branches: 75, functions: 80, lines: 95 },
        "src/utils/duration-parser.ts": { statements: 95, branches: 90, functions: 100, lines: 100 },
        "src/utils/ids.ts": { statements: 100, branches: 100, functions: 100, lines: 100 }
      }
    }
  }
});
