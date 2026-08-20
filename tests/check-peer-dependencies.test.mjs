import { describe, expect, it } from "vitest";
import {
  classifyPeerDependencyReport,
  evaluateNpmLsResult,
  runPeerDependencyCheck
} from "../scripts/check-peer-dependencies.mjs";

const CURRENT_OBSIDIAN_PROBLEMS = [
  "missing: @codemirror/state@6.5.0, required by obsidian-min@npm:obsidian@1.10.0",
  "missing: @codemirror/view@6.38.1, required by obsidian-min@npm:obsidian@1.10.0",
  "missing: @codemirror/state@6.5.0, required by obsidian@1.12.3",
  "missing: @codemirror/view@6.38.6, required by obsidian@1.12.3",
  "missing: @codemirror/state@6.5.0, required by obsidian@1.13.1",
  "missing: @codemirror/view@6.38.6, required by obsidian@1.13.1"
];

function report(problems = []) {
  return {
    version: "1.0.0",
    name: "alarm-timer",
    problems,
    dependencies: {}
  };
}

describe("peer dependency policy", () => {
  it("accepts the exact reviewed Obsidian and CodeMirror conflict set", () => {
    expect(classifyPeerDependencyReport(report(CURRENT_OBSIDIAN_PROBLEMS))).toEqual({
      allowedProblems: [...CURRENT_OBSIDIAN_PROBLEMS].sort(),
      clean: false
    });
  });

  it("deduplicates allowed conflicts repeated in nested dependency nodes", () => {
    const value = report(CURRENT_OBSIDIAN_PROBLEMS);
    value.dependencies.obsidian = { problems: [CURRENT_OBSIDIAN_PROBLEMS[4]] };

    expect(classifyPeerDependencyReport(value).allowedProblems).toHaveLength(6);
  });

  it("rejects an ESLint peer mismatch", () => {
    expect(() => classifyPeerDependencyReport(report([
      "invalid: eslint@10.7.0 /tmp/project/node_modules/eslint"
    ]))).toThrow("Unapproved npm peer problem(s):");
  });

  it("rejects an unrelated conflict alongside the allowed conflicts", () => {
    expect(() => classifyPeerDependencyReport(report([
      ...CURRENT_OBSIDIAN_PROBLEMS,
      "missing: react@19.0.0, required by unrelated-package@1.0.0"
    ]))).toThrow("missing: react@19.0.0");
  });

  it("rejects malformed JSON", () => {
    expect(() => evaluateNpmLsResult({
      stdout: "{",
      exitCode: 1,
      signal: null
    })).toThrow("npm ls did not return valid JSON.");
  });

  it("reports a spawn failure without executing npm", async () => {
    await expect(runPeerDependencyCheck(async () => {
      throw new Error("ENOENT");
    })).rejects.toThrow("Could not run npm ls: ENOENT.");
  });

  it("rejects an unexpected nonzero result with no peer problems", () => {
    expect(() => evaluateNpmLsResult({
      stdout: JSON.stringify(report()),
      exitCode: 2,
      signal: null
    })).toThrow("npm ls exited with code 2 without reporting a peer problem.");
  });

  it("accepts a successful report with zero peer problems", () => {
    expect(evaluateNpmLsResult({
      stdout: JSON.stringify(report()),
      exitCode: 0,
      signal: null
    })).toEqual({ allowedProblems: [], clean: true });
  });
});
