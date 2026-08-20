import esbuild from "esbuild";
import process from "node:process";
import { builtinModules } from "node:module";
import { installTestVault, parseVaultTarget } from "./scripts/install-test-vault.mjs";

const arguments_ = process.argv.slice(2);
const production = arguments_[0] === "production";
const buildArguments = production ? arguments_.slice(1) : arguments_;
if (production && buildArguments.length > 0) throw new Error("Production builds do not accept test-vault arguments.");
const shouldSyncTestVault = !production && (process.env.npm_lifecycle_event === "obsidian:dev" || buildArguments.length > 0);
const testVaultPath = shouldSyncTestVault ? parseVaultTarget(buildArguments) : undefined;

const plugins = testVaultPath === undefined ? [] : [{
  name: "sync-test-vault",
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length === 0) await installTestVault({ vaultPath: testVaultPath });
    });
  }
}];

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: production,
  plugins
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
