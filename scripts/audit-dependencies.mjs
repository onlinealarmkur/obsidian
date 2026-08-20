import { execFile } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runPeerDependencyCheck } from "./check-peer-dependencies.mjs";

const execFileAsync = promisify(execFile);
const HIGH_SEVERITIES = new Set(["high", "critical"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireAuditReport(value, label) {
  if (!isRecord(value) || value.auditReportVersion !== 2 || !isRecord(value.vulnerabilities)) {
    throw new Error(`${label} npm audit JSON has an unsupported shape.`);
  }
  return value;
}

function highVulnerabilities(report) {
  return Object.entries(report.vulnerabilities)
    .filter(([, vulnerability]) =>
      isRecord(vulnerability) && typeof vulnerability.severity === "string" &&
      HIGH_SEVERITIES.has(vulnerability.severity)
    );
}

function requireVulnerabilityMetadata(report, label) {
  const metadata = isRecord(report.metadata) && isRecord(report.metadata.vulnerabilities)
    ? report.metadata.vulnerabilities
    : undefined;
  if (
    metadata === undefined
    || !Number.isInteger(metadata.high)
    || !Number.isInteger(metadata.critical)
    || metadata.high < 0
    || metadata.critical < 0
  ) {
    throw new Error(`${label} npm audit JSON has unsupported vulnerability metadata.`);
  }
  return metadata;
}

export function evaluateAuditPolicy(runtimeValue, fullValue) {
  const runtime = requireAuditReport(runtimeValue, "Runtime");
  const full = requireAuditReport(fullValue, "Full");
  const runtimeHigh = highVulnerabilities(runtime);
  const runtimeMetadata = requireVulnerabilityMetadata(runtime, "Runtime");
  if (runtimeMetadata.high + runtimeMetadata.critical !== runtimeHigh.length) {
    throw new Error("Runtime npm audit vulnerability metadata does not match its high and critical findings.");
  }
  if (runtimeHigh.length > 0) {
    throw new Error("Runtime dependency audit contains a high or critical vulnerability.");
  }

  const fullHigh = highVulnerabilities(full);
  const fullMetadata = requireVulnerabilityMetadata(full, "Full");
  if (fullMetadata.high + fullMetadata.critical !== fullHigh.length) {
    throw new Error("Full npm audit vulnerability metadata does not match its high and critical findings.");
  }
  if (fullHigh.length > 0) {
    throw new Error("Full dependency audit contains a high or critical vulnerability.");
  }
  return { clean: true };
}

function parseJson(output, label) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${label} npm audit did not return valid JSON.`);
  }
}

async function runAudit(arguments_) {
  const npmExecPath = process.env.npm_execpath;
  const file = npmExecPath === undefined ? "npm" : process.execPath;
  const args = npmExecPath === undefined
    ? ["audit", ...arguments_, "--json"]
    : [npmExecPath, "audit", ...arguments_, "--json"];
  try {
    const result = await execFileAsync(file, args, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024
    });
    return result.stdout;
  } catch (error) {
    if (isRecord(error) && typeof error.stdout === "string" && error.stdout.trim() !== "") {
      return error.stdout;
    }
    throw error;
  }
}

export async function runDependencyAudit() {
  const runtime = parseJson(
    await runAudit(["--omit=dev", "--audit-level=high"]),
    "Runtime"
  );
  const full = parseJson(
    await runAudit(["--audit-level=high"]),
    "Full"
  );
  await runPeerDependencyCheck();
  return evaluateAuditPolicy(runtime, full);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await runDependencyAudit();
    process.stdout.write("Runtime dependency audit is clean at high and critical severity.\n");
    process.stdout.write("Full dependency audit has no high or critical vulnerabilities.\n");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Dependency audit failed."}\n`);
    process.exitCode = 1;
  }
}
