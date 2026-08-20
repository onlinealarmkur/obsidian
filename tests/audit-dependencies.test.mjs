import { describe, expect, it } from "vitest";
import { evaluateAuditPolicy } from "../scripts/audit-dependencies.mjs";

function report(vulnerabilities = {}) {
  const entries = Object.values(vulnerabilities);
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: entries.filter((entry) => entry.severity === "high").length,
        critical: entries.filter((entry) => entry.severity === "critical").length,
        total: entries.length
      }
    }
  };
}

function vulnerable(name, severity = "high") {
  return { name, severity, via: [], effects: [], fixAvailable: false };
}

describe("dependency audit policy", () => {
  it("accepts only clean runtime and full dependency reports", () => {
    expect(evaluateAuditPolicy(report(), report())).toEqual({ clean: true });
  });

  it("rejects any high-severity runtime advisory", () => {
    expect(() => evaluateAuditPolicy(
      report({ runtime: vulnerable("runtime") }),
      report()
    )).toThrow("Runtime dependency audit contains a high or critical vulnerability.");
  });

  it.each(["high", "critical"])("rejects a %s development advisory", (severity) => {
    expect(() => evaluateAuditPolicy(
      report(),
      report({ tooling: vulnerable("tooling", severity) })
    )).toThrow("Full dependency audit contains a high or critical vulnerability.");
  });

  it.each(["Runtime", "Full"])("rejects inconsistent %s audit metadata", (label) => {
    const inconsistent = report();
    inconsistent.metadata.vulnerabilities.high = 1;
    const runtime = label === "Runtime" ? inconsistent : report();
    const full = label === "Full" ? inconsistent : report();

    expect(() => evaluateAuditPolicy(runtime, full)).toThrow(
      `${label} npm audit vulnerability metadata does not match its high and critical findings.`
    );
  });

  it.each(["Runtime", "Full"])("rejects malformed %s audit output", (label) => {
    const runtime = label === "Runtime" ? {} : report();
    const full = label === "Full" ? {} : report();

    expect(() => evaluateAuditPolicy(runtime, full)).toThrow(
      `${label} npm audit JSON has an unsupported shape.`
    );
  });
});
