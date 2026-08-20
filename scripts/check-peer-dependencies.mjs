import { execFile } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export const ALLOWED_PEER_PROBLEMS = Object.freeze([
  "missing: @codemirror/state@6.5.0, required by obsidian-min@npm:obsidian@1.10.0",
  "missing: @codemirror/view@6.38.1, required by obsidian-min@npm:obsidian@1.10.0",
  "missing: @codemirror/state@6.5.0, required by obsidian@1.12.3",
  "missing: @codemirror/view@6.38.6, required by obsidian@1.12.3",
  "missing: @codemirror/state@6.5.0, required by obsidian@1.13.1",
  "missing: @codemirror/view@6.38.6, required by obsidian@1.13.1"
]);

const ALLOWED_PEER_PROBLEM_SET = new Set(ALLOWED_PEER_PROBLEMS);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeProblem(problem) {
  return problem
    .replaceAll("\\", "/")
    .replace(/(?:[A-Za-z]:)?\/[^,\n]*\/node_modules\//gu, "<project>/node_modules/")
    .trim();
}

function collectProblems(value, problems = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectProblems(entry, problems);
    return problems;
  }
  if (!isRecord(value)) return problems;

  if ("problems" in value) {
    if (!Array.isArray(value.problems) || value.problems.some((problem) => typeof problem !== "string")) {
      throw new Error("npm ls returned malformed peer-problem data.");
    }
    problems.push(...value.problems.map(normalizeProblem));
  }

  for (const [key, entry] of Object.entries(value)) {
    if (key !== "problems") collectProblems(entry, problems);
  }
  return problems;
}

export function classifyPeerDependencyReport(value) {
  if (!isRecord(value) || typeof value.name !== "string") {
    throw new Error("npm ls JSON has an unsupported shape.");
  }

  const problems = [...new Set(collectProblems(value))].sort();
  const unexpectedProblems = problems.filter((problem) => !ALLOWED_PEER_PROBLEM_SET.has(problem));
  if (unexpectedProblems.length > 0) {
    throw new Error(`Unapproved npm peer problem(s):\n- ${unexpectedProblems.join("\n- ")}`);
  }

  return {
    allowedProblems: problems,
    clean: problems.length === 0
  };
}

function parseReport(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("npm ls did not return valid JSON.");
  }
}

export function evaluateNpmLsResult(result) {
  if (
    !isRecord(result)
    || typeof result.stdout !== "string"
    || !Number.isInteger(result.exitCode)
    || (result.signal !== null && typeof result.signal !== "string")
  ) {
    throw new Error("npm ls returned an unsupported process result.");
  }
  if (result.signal !== null) {
    throw new Error(`npm ls was terminated by signal ${result.signal}.`);
  }

  const classification = classifyPeerDependencyReport(parseReport(result.stdout));
  if (classification.clean && result.exitCode !== 0) {
    throw new Error(`npm ls exited with code ${result.exitCode} without reporting a peer problem.`);
  }
  if (!classification.clean && result.exitCode === 0) {
    throw new Error("npm ls reported peer problems but exited successfully.");
  }
  return classification;
}

async function executeNpmLs() {
  const npmExecPath = process.env.npm_execpath;
  const file = npmExecPath === undefined ? "npm" : process.execPath;
  const args = npmExecPath === undefined
    ? ["ls", "--all", "--json"]
    : [npmExecPath, "ls", "--all", "--json"];

  try {
    const result = await execFileAsync(file, args, {
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT_BYTES
    });
    return { stdout: result.stdout, exitCode: 0, signal: null };
  } catch (error) {
    if (
      isRecord(error)
      && typeof error.stdout === "string"
      && Number.isInteger(error.code)
    ) {
      return {
        stdout: error.stdout,
        exitCode: error.code,
        signal: typeof error.signal === "string" ? error.signal : null
      };
    }
    throw error;
  }
}

export async function runPeerDependencyCheck(runNpmLs = executeNpmLs) {
  let result;
  try {
    result = await runNpmLs();
  } catch (error) {
    const detail = error instanceof Error && error.message !== "" ? `: ${error.message}` : "";
    throw new Error(`Could not run npm ls${detail}.`);
  }
  return evaluateNpmLsResult(result);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await runPeerDependencyCheck();
    if (result.clean) {
      process.stdout.write("npm peer dependency graph is clean.\n");
    } else {
      process.stdout.write(
        `npm peer dependency graph contains only ${result.allowedProblems.length} reviewed Obsidian/CodeMirror problem(s).\n`
      );
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Peer dependency check failed."}\n`);
    process.exitCode = 1;
  }
}
