import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import eslintConfig from "../eslint.config.mjs";
import vitestConfig from "../vitest.config.ts";

const projectRoot = resolve(import.meta.dirname, "..");

async function readJson(filename) {
  return JSON.parse(await readFile(resolve(projectRoot, filename), "utf8"));
}

function globalsFor(files) {
  return eslintConfig.find((config) =>
    config.files?.length === files.length
    && files.every((file) => config.files.includes(file))
    && config.languageOptions?.globals !== undefined
  )?.languageOptions.globals;
}

describe("tooling runtime boundaries", () => {
  it("enables strict mode and isolates production compilation from ambient Node types", async () => {
    const [rootConfig, productionConfig, minimumConfig] = await Promise.all([
      readJson("tsconfig.json"),
      readJson("tsconfig.production.json"),
      readJson("tsconfig.min-obsidian.json")
    ]);

    expect(rootConfig.compilerOptions.strict).toBe(true);
    expect(rootConfig.include).toContain("vitest.config.ts");
    expect(productionConfig.extends).toBe("./tsconfig.json");
    expect(productionConfig.compilerOptions.types).toEqual([]);
    expect(productionConfig.include).toEqual(["src/**/*.ts"]);
    expect(minimumConfig.extends).toBe("./tsconfig.production.json");
    expect(minimumConfig.compilerOptions).not.toHaveProperty("types");
  });

  it("runs both project and production checks from normal gates", async () => {
    const packageJson = await readJson("package.json");
    const scripts = packageJson.scripts;

    expect(scripts["typecheck:project"]).toBe("tsc --noEmit");
    expect(scripts["typecheck:production"]).toBe("tsc --noEmit -p tsconfig.production.json");
    expect(scripts.typecheck).toContain("npm run typecheck:project");
    expect(scripts.typecheck).toContain("npm run typecheck:production");
    expect(scripts.build).toMatch(/^npm run typecheck &&/u);
    expect(scripts["check:fast"]).toContain("npm run typecheck");
    expect(scripts["check:fast"]).toMatch(/^npm run check:peers &&/u);
    expect(scripts.check).toContain("npm run build");
    expect(scripts.check).toMatch(/^npm run check:peers &&/u);
    expect(scripts.lint).toBe("eslint . --max-warnings 0");
    expect(scripts["check:peers"]).toBe("node scripts/check-peer-dependencies.mjs");
    expect(scripts["audit:dependencies"]).toBe("node scripts/audit-dependencies.mjs");
  });

  it("exposes browser-only globals to source and Node globals only to tooling", () => {
    const sourceGlobals = globalsFor(["src/**/*.ts"]);
    const testGlobals = globalsFor(["tests/**/*.ts"]);
    const vitestConfigGlobals = globalsFor(["vitest.config.ts"]);
    const typedVitestConfig = eslintConfig.find((config) =>
      config.files?.includes("vitest.config.ts")
      && config.languageOptions?.parserOptions?.projectService === true
    );

    expect(sourceGlobals).toHaveProperty("window");
    expect(sourceGlobals).not.toHaveProperty("process");
    expect(testGlobals).toHaveProperty("window");
    expect(testGlobals).toHaveProperty("process");
    expect(vitestConfigGlobals).toHaveProperty("process");
    expect(vitestConfigGlobals).not.toHaveProperty("window");
    expect(typedVitestConfig).toBeDefined();
  });

  it("enforces critical utility coverage floors", () => {
    const thresholds = vitestConfig.test?.coverage?.thresholds;

    expect(thresholds?.["src/utils/ids.ts"]).toEqual({
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100
    });
    expect(thresholds?.["src/utils/duration-parser.ts"]).toEqual({
      statements: 95,
      branches: 90,
      functions: 100,
      lines: 100
    });
  });

  it("keeps long labels inside sidebar cards and alert modals", async () => {
    const styles = await readFile(resolve(projectRoot, "styles.css"), "utf8");

    expect(styles).toContain(".online-alarm-timer-card-summary strong");
    expect(styles).toMatch(/\.online-alarm-timer-card-summary strong\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;/su);
    expect(styles).toMatch(/\.online-alarm-timer-alert-label\s*\{[^}]*max-width:\s*100%;[^}]*overflow-wrap:\s*anywhere;/su);
  });
});
