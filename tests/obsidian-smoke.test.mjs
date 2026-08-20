import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  defaultRunProcess,
  DISPOSABLE_SENTINEL,
  formatSmokeError,
  parseSmokeArguments,
  runObsidianSmoke
} from "../scripts/obsidian-smoke.mjs";

let temporaryRoot;
let vaultPath;
let cliPath;
let cliTargetPath;
const PRESERVED_FIXTURE_TEXT = "preserved fixture plugin data";

async function prepareFilesystem({ sentinel = true } = {}) {
  temporaryRoot = await mkdtemp(join(tmpdir(), "alarm-timer-smoke-"));
  vaultPath = join(temporaryRoot, "Explicit Disposable Vault");
  cliPath = join(temporaryRoot, "obsidian-cli");
  cliTargetPath = join(temporaryRoot, "obsidian-cli-target");
  await mkdir(join(vaultPath, ".obsidian"), { recursive: true });
  if (sentinel) await writeFile(join(vaultPath, DISPOSABLE_SENTINEL), "alarm-timer\n");
  await writeFile(cliTargetPath, "#!/bin/sh\nexit 0\n");
  await chmod(cliTargetPath, 0o755);
  await symlink(cliTargetPath, cliPath);
}

function options(overrides = {}) {
  return {
    help: false,
    vaultPath,
    obsidianVault: "explicit-test-vault-id",
    cliPath,
    ...overrides
  };
}

function evalMarker(args) {
  const code = args.find((argument) => argument.startsWith("code=")) ?? "";
  return /alarm-timer-smoke:([a-z-]+)/u.exec(code)?.[1];
}

function commandIndex(args) {
  return args[0]?.startsWith("vault=") ? 1 : 0;
}

function fakeRunner({
  reportedVault = vaultPath,
  enabled = true,
  initialErrors = "",
  errors = "",
  evalPrefix = "",
  falseEvalMarkers = [],
  throwEvalMarkers = []
} = {}) {
  let dataRestored = false;
  let snapshotValue;
  let snapshotDeleted = false;
  const preservedSnapshot = JSON.stringify({ schemaVersion: 1, settings: { preserved: PRESERVED_FIXTURE_TEXT }, items: [{ id: "existing" }] });
  const calls = [];
  let developerErrorCalls = 0;
  const evalAttempts = new Map();
  const evalOutput = (value) => ({ stdout: `${evalPrefix}${value}\n`, stderr: "" });
  const runProcess = vi.fn(async (file, args, processOptions = {}) => {
    calls.push({ file, args: [...args], options: { ...processOptions } });
    const index = commandIndex(args);
    const command = args[index];
    if (command === "vault") return { stdout: `${reportedVault}\n`, stderr: "" };
    if (command === "plugins:enabled") return { stdout: enabled ? "alarm-timer\t1.0.0\n" : "another-plugin\n", stderr: "" };
    if (command === "eval") {
      const marker = evalMarker(args);
      const attempts = (evalAttempts.get(marker) ?? 0) + 1;
      evalAttempts.set(marker, attempts);
      if (throwEvalMarkers.includes(marker)) throw new Error(`mock eval failure: ${marker}`);
      const forcedFalse = falseEvalMarkers.includes(marker);
      if (marker === "snapshot-plugin-data") {
        if (!forcedFalse) snapshotValue = preservedSnapshot;
        return evalOutput(!forcedFalse);
      }
      if (marker === "verify-snapshot-survived-reload") return evalOutput(!forcedFalse && snapshotValue !== undefined);
      if (marker === "restore-plugin-data") {
        if (!forcedFalse && snapshotValue !== undefined) dataRestored = true;
        return evalOutput(!forcedFalse && snapshotValue !== undefined);
      }
      if (marker === "verify-plugin-data-restored") return evalOutput(!forcedFalse && snapshotValue !== undefined && dataRestored);
      if (marker === "delete-plugin-data-snapshot") {
        if (!forcedFalse) {
          snapshotValue = undefined;
          snapshotDeleted = true;
        }
        return evalOutput(!forcedFalse);
      }
      return evalOutput(!forcedFalse);
    }
    if (command === "dev:dom") return { stdout: "1\n", stderr: "" };
    if (command === "dev:errors") {
      const stdout = developerErrorCalls === 0 ? initialErrors : errors;
      developerErrorCalls += 1;
      return { stdout, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
  return {
    calls,
    runProcess,
    hasSnapshot: () => snapshotValue !== undefined,
    wasDataRestored: () => dataRestored,
    wasSnapshotDeleted: () => snapshotDeleted
  };
}

function dependencies(runner, overrides = {}) {
  return {
    runProcess: runner.runProcess,
    build: vi.fn(),
    install: vi.fn(),
    log: () => undefined,
    wait: () => Promise.resolve(),
    workflowLabel: "alarm-timer-smoke-test",
    snapshotKey: "__alarmTimerSmokeSnapshot_test",
    ...overrides
  };
}

function evalCallsForMarker(runner, marker) {
  return runner.calls.filter((call) => call.args[commandIndex(call.args)] === "eval" && evalMarker(call.args) === marker);
}

function evalCodeForMarker(runner, marker) {
  return evalCallsForMarker(runner, marker)[0]?.args.find((argument) => argument.startsWith("code=")) ?? "";
}

function expectDismissBeforeQuiescence(runner) {
  const dismissIndex = runner.calls.findIndex((call) => {
    const index = commandIndex(call.args);
    return call.args[index] === "command" && call.args[index + 1] === "id=alarm-timer:dismiss-ringing-alert";
  });
  const quiesceIndex = runner.calls.findIndex((call) => call.args[commandIndex(call.args)] === "eval" && evalMarker(call.args) === "quiesce-plugin-data-writes");
  expect(dismissIndex).toBeGreaterThan(-1);
  expect(quiesceIndex).toBe(dismissIndex + 1);
}

function expectVerifiedSnapshotCleanup(runner) {
  expectDismissBeforeQuiescence(runner);
  const markers = runner.calls
    .filter((call) => call.args[commandIndex(call.args)] === "eval")
    .map((call) => evalMarker(call.args));
  const quiesceIndex = markers.indexOf("quiesce-plugin-data-writes");
  expect(markers[quiesceIndex + 1]).toBe("restore-plugin-data");
  expect(markers).toContain("verify-plugin-data-restored");
  expect(markers).toContain("delete-plugin-data-snapshot");
  expect(runner.wasDataRestored()).toBe(true);
  expect(runner.wasSnapshotDeleted()).toBe(true);
  expect(runner.hasSnapshot()).toBe(false);
}

async function expectScreenshotPreflightFailure(screenshotPath, expectedMessage) {
  const runner = fakeRunner();
  const build = vi.fn();
  const install = vi.fn();

  await expect(runObsidianSmoke(options({ screenshotPath }), {
    runProcess: runner.runProcess,
    build,
    install
  })).rejects.toThrow(expectedMessage);

  expect(runner.runProcess).not.toHaveBeenCalled();
  expect(build).not.toHaveBeenCalled();
  expect(install).not.toHaveBeenCalled();
}

describe("guarded Obsidian smoke test", () => {
  beforeEach(async () => {
    await prepareFilesystem();
  });

  afterEach(async () => {
    if (temporaryRoot !== undefined) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("parses help without requiring or inferring a vault", () => {
    expect(parseSmokeArguments(["--help"])).toEqual({ help: true });
    expect(() => parseSmokeArguments([])).toThrow(/--vault is required/);
    expect(() => parseSmokeArguments(["--vault", "relative", "--obsidian-vault", "id", "--cli", cliPath])).toThrow(/absolute/);
    expect(() => parseSmokeArguments(["--vault", vaultPath, "--obsidian-vault", "id", "--cli", "relative"])).toThrow(/absolute/);
    expect(parseSmokeArguments([
      "--vault", vaultPath,
      "--cli", cliPath,
      "--expected-language", "pt"
    ])).toMatchObject({ expectedLanguage: "pt", obsidianVault: undefined });
    expect(() => parseSmokeArguments([
      "--vault", vaultPath,
      "--obsidian-vault", "id",
      "--cli", cliPath,
      "--expected-language", "pt-BR"
    ])).toThrow(/one of/);
  });

  it("redacts evaluated code from subprocess errors", async () => {
    await writeFile(cliPath, "#!/bin/sh\nprintf '%s\\n' \"$3\" >&2\nexit 1\n");
    await chmod(cliPath, 0o755);
    let thrown;

    try {
      await defaultRunProcess(cliPath, ["vault=explicit-test-vault-id", "eval", `code=private payload ${PRESERVED_FIXTURE_TEXT}`]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) throw new Error("Expected subprocess failure.");
    expect(thrown.message).toContain("code=<redacted>");
    expect(thrown.message).not.toContain("private payload");
    expect(thrown.message).not.toContain(PRESERVED_FIXTURE_TEXT);
  });

  it("reports nested workflow and cleanup failures instead of hiding their causes", () => {
    const error = new AggregateError([
      new Error("workflow detail"),
      new AggregateError([new Error("cleanup detail")], "nested cleanup")
    ], "smoke failed");

    expect(formatSmokeError(error)).toBe([
      "smoke failed",
      "1. workflow detail",
      "2. nested cleanup",
      "1. cleanup detail"
    ].join("\n"));
  });

  it("requires the explicit disposable sentinel before spawning or mutating", async () => {
    await rm(join(vaultPath, DISPOSABLE_SENTINEL));
    const runner = fakeRunner();
    const build = vi.fn();
    const install = vi.fn();

    await expect(runObsidianSmoke(options(), { runProcess: runner.runProcess, build, install })).rejects.toThrow(/sentinel/);

    expect(runner.runProcess).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it("stops on canonical vault mismatch before build, install, reload, or enable", async () => {
    const otherVault = join(temporaryRoot, "Other Vault");
    await mkdir(otherVault);
    const runner = fakeRunner({ reportedVault: otherVault });
    const build = vi.fn();
    const install = vi.fn();

    await expect(runObsidianSmoke(options(), { runProcess: runner.runProcess, build, install })).rejects.toThrow(/vault mismatch/);

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.args).toEqual(["vault=explicit-test-vault-id", "vault", "info=path"]);
    expect(build).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it("requires an already-enabled plugin and never enables or discovers one", async () => {
    const runner = fakeRunner({ enabled: false });
    const build = vi.fn();
    const install = vi.fn();

    await expect(runObsidianSmoke(options(), { runProcess: runner.runProcess, build, install })).rejects.toThrow(/already be enabled/);

    expect(runner.calls.map((call) => call.args[1])).toEqual(["vault", "plugins:enabled"]);
    expect(runner.calls.flatMap((call) => call.args)).not.toContain("plugin:enable");
    expect(runner.calls.flatMap((call) => call.args)).not.toContain("vaults");
    expect(build).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it("targets every CLI call explicitly, installs only after guards, and restores plugin data", async () => {
    const runner = fakeRunner();
    const sequence = [];
    const build = vi.fn(async () => { sequence.push("build"); });
    const install = vi.fn(async () => { sequence.push("install"); });
    const wait = vi.fn(async (milliseconds) => { sequence.push(`wait:${milliseconds}`); });
    const runProcess = vi.fn(async (...args) => {
      const command = args[1][1];
      sequence.push(command === "eval" ? `eval:${evalMarker(args[1])}` : command);
      return runner.runProcess(...args);
    });

    await runObsidianSmoke(options(), dependencies(runner, { runProcess, build, install, wait }));

    expect(sequence.slice(0, 6)).toEqual([
      "vault",
      "plugins:enabled",
      "eval:snapshot-plugin-data",
      "build",
      "install",
      "dev:errors"
    ]);
    const cliCalls = runner.calls;
    expect(cliCalls.every((call) => call.file === cliPath && call.args[0] === "vault=explicit-test-vault-id")).toBe(true);
    expect(cliCalls.flatMap((call) => call.args)).not.toContain("plugin:enable");
    expect(cliCalls.flatMap((call) => call.args)).not.toContain("vaults");
    expect(cliCalls.map((call) => call.args.slice(1))).toContainEqual(["plugin:reload", "id=alarm-timer"]);
    expect(cliCalls.map((call) => call.args.slice(1))).toContainEqual(["command", "id=alarm-timer:open-view"]);
    expect(cliCalls.filter((call) => call.args[1] === "dev:dom")).toHaveLength(2);
    expect(cliCalls.filter((call) => call.args[1] === "dev:errors")).toHaveLength(2);
    expect(cliCalls.filter((call) => call.args[1] === "plugin:reload")).toHaveLength(4);
    expect(cliCalls.filter((call) => call.args[1] === "command")).toHaveLength(4);
    expect(cliCalls.map((call) => call.args.slice(1))).toContainEqual(["command", "id=alarm-timer:dismiss-ringing-alert"]);
    expect(cliCalls.filter((call) => call.args[1] === "eval").map((call) => evalMarker(call.args))).toEqual([
      "snapshot-plugin-data",
      "verify-snapshot-survived-reload",
      "verify-plugin-language",
      "localized-shell",
      "select-alarm-tab",
      "create-alarm",
      "created-alarm-visible",
      "alarm-actions-match",
      "edit-alarm",
      "edited-alarm-persisted",
      "force-alarm-catch-up",
      "alarm-fired-and-modal-visible",
      "dismiss-alarm-alert",
      "alarm-alert-completed",
      "alarm-completion-survived-reload",
      "select-timer-tab",
      "create-timer",
      "created-timer-visible",
      "timer-actions-match",
      "pause-timer",
      "paused-timer-persisted",
      "resume-timer",
      "resumed-timer-persisted",
      "restart-timer",
      "restarted-timer-persisted",
      "cancel-timer",
      "cancelled-timer-visible",
      "cancelled-timer-survived-reload",
      "cancelled-card-survived-reload",
      "select-due-timer-tab",
      "create-due-timer",
      "due-timer-active-persisted",
      "wake-due-timer",
      "due-timer-fired-and-modal-visible",
      "dismiss-due-alert",
      "due-alert-dismissed",
      "quiesce-plugin-data-writes",
      "restore-plugin-data",
      "verify-plugin-data-restored",
      "delete-plugin-data-snapshot"
    ]);
    expect(evalCodeForMarker(runner, "create-due-timer")).toContain('duration.value="5s"');
    expect(evalCodeForMarker(runner, "alarm-actions-match")).toContain('JSON.stringify(["Edit","Cancel"])');
    expect(evalCodeForMarker(runner, "alarm-fired-and-modal-visible")).toContain('JSON.stringify(["Stop"])');
    expect(evalCodeForMarker(runner, "alarm-alert-completed")).toContain('item.status==="completed"');
    expect(evalCodeForMarker(runner, "alarm-completion-survived-reload")).toContain('modal===undefined');
    expect(evalCodeForMarker(runner, "create-due-timer")).toContain("alarm-timer-smoke-test-due-alert");
    expect(evalCodeForMarker(runner, "wake-due-timer")).toContain('window.dispatchEvent(new Event("focus"))');
    expect(wait).toHaveBeenCalledWith(5_500);
    const wakeIndex = sequence.indexOf("eval:wake-due-timer");
    expect(wakeIndex).toBeGreaterThan(0);
    expect(sequence[wakeIndex - 1]).toBe("wait:5500");
    expect(evalCodeForMarker(runner, "due-timer-fired-and-modal-visible")).toContain('item.status==="fired"');
    expect(evalCodeForMarker(runner, "due-timer-fired-and-modal-visible")).toContain("Number.isFinite(item.firedAt)");
    expect(evalCodeForMarker(runner, "due-timer-fired-and-modal-visible")).toContain(".online-alarm-timer-alert-modal");
    expect(evalCodeForMarker(runner, "dismiss-due-alert")).toContain('JSON.stringify(["Restart","Stop"])');
    expect(evalCodeForMarker(runner, "dismiss-due-alert")).toContain('textContent?.trim()==="Stop"');
    expect(evalCodeForMarker(runner, "dismiss-due-alert")).toContain("button.click()");
    expect(evalCodeForMarker(runner, "due-alert-dismissed")).toContain('textContent?.trim()==="Completed"');
    expect(evalCodeForMarker(runner, "due-alert-dismissed")).toContain('item.status==="completed"');
    expect(evalCodeForMarker(runner, "snapshot-plugin-data")).toContain("sessionStorage.setItem");
    expect(evalCodeForMarker(runner, "restore-plugin-data")).toContain("sessionStorage.getItem");
    expect(evalCodeForMarker(runner, "delete-plugin-data-snapshot")).toContain("sessionStorage.removeItem");
    expect(evalCodeForMarker(runner, "snapshot-plugin-data")).not.toContain("globalThis[");
    expectDismissBeforeQuiescence(runner);
    expect(runner.wasDataRestored()).toBe(true);
    expect(runner.wasSnapshotDeleted()).toBe(true);
    expect(runner.hasSnapshot()).toBe(false);
    expect(cliCalls.flatMap((call) => call.args).some((argument) => argument.includes(PRESERVED_FIXTURE_TEXT))).toBe(false);
    expect(build).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledWith(expect.objectContaining({ vaultPath: await realpath(vaultPath), sourceRoot: expect.any(String) }));
  });

  it("safely targets the explicit vault by CLI working directory without requiring its name or ID", async () => {
    const runner = fakeRunner();

    await runObsidianSmoke(options({ obsidianVault: undefined }), dependencies(runner));

    const canonicalVault = await realpath(vaultPath);
    expect(runner.calls.every((call) => call.options.cwd === canonicalVault)).toBe(true);
    expect(runner.calls.every((call) => !call.args.some((argument) => argument.startsWith("vault=")))).toBe(true);
    expect(runner.calls[0]?.args).toEqual(["vault", "info=path"]);
    expect(runner.calls.flatMap((call) => call.args)).not.toContain("vaults");
    expect(runner.calls.flatMap((call) => call.args)).not.toContain("plugin:enable");
    expectVerifiedSnapshotCleanup(runner);
  });

  it("uses the selected locale table for text-driven installed-app actions", async () => {
    const runner = fakeRunner();

    await runObsidianSmoke(options({ expectedLanguage: "pt" }), dependencies(runner));

    expect(evalCodeForMarker(runner, "verify-plugin-language")).toContain('"pt"');
    expect(evalCodeForMarker(runner, "localized-shell")).toContain("Alarm and Timer");
    expect(evalCodeForMarker(runner, "alarm-actions-match")).toContain('JSON.stringify(["Editar","Cancelar"])');
    expect(evalCodeForMarker(runner, "dismiss-due-alert")).toContain('JSON.stringify(["Reiniciar","Parar"])');
    expectVerifiedSnapshotCleanup(runner);
  });

  it("fails before explicit UI workflow on a configured-language mismatch and restores data", async () => {
    const runner = fakeRunner({ falseEvalMarkers: ["verify-plugin-language"] });

    await expect(runObsidianSmoke(options({ expectedLanguage: "tr" }), dependencies(runner))).rejects.toThrow(/Plugin language tr/);

    const markers = runner.calls.filter((call) => call.args[1] === "eval").map((call) => evalMarker(call.args));
    expect(markers).not.toContain("localized-shell");
    expect(markers).not.toContain("select-alarm-tab");
    expectVerifiedSnapshotCleanup(runner);
  });

  it("accepts the eval-result prefix emitted by Obsidian 1.12", async () => {
    const runner = fakeRunner({ evalPrefix: "=> " });

    await runObsidianSmoke(options(), dependencies(runner));

    expect(runner.wasDataRestored()).toBe(true);
    expect(runner.wasSnapshotDeleted()).toBe(true);
    expect(runner.hasSnapshot()).toBe(false);
  });

  it("accepts the empty developer-error message emitted by Obsidian 1.12", async () => {
    const runner = fakeRunner({ errors: "No errors captured.\n" });

    await runObsidianSmoke(options(), dependencies(runner));

    expectVerifiedSnapshotCleanup(runner);
  });

  it("stops before build or install when the plugin data cannot be snapshotted", async () => {
    const runner = fakeRunner({ throwEvalMarkers: ["snapshot-plugin-data"] });
    const build = vi.fn();
    const install = vi.fn();

    await expect(runObsidianSmoke(options(), dependencies(runner, { build, install }))).rejects.toThrow(/snapshot-plugin-data/);

    expect(build).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(runner.wasDataRestored()).toBe(false);
    expect(runner.wasSnapshotDeleted()).toBe(true);
    expect(runner.calls.map((call) => call.args[1])).toEqual(["vault", "plugins:enabled", "eval", "eval"]);
  });

  it("restores plugin data after a workflow assertion fails and stops later actions", async () => {
    const runner = fakeRunner({ falseEvalMarkers: ["timer-actions-match"] });

    await expect(runObsidianSmoke(options(), dependencies(runner))).rejects.toThrow(/Timer action model/);

    const markers = runner.calls.filter((call) => call.args[1] === "eval").map((call) => evalMarker(call.args));
    expect(markers).not.toContain("pause-timer");
    expectVerifiedSnapshotCleanup(runner);
  });

  it("bounds a missing active-persistence observation and restores the snapshot", async () => {
    const runner = fakeRunner({ falseEvalMarkers: ["due-timer-active-persisted"] });
    const wait = vi.fn(() => Promise.resolve());

    await expect(runObsidianSmoke(options(), dependencies(runner, { wait }))).rejects.toThrow(/Due-timer active persistence/);

    expect(evalCallsForMarker(runner, "due-timer-active-persisted")).toHaveLength(30);
    expect(wait).toHaveBeenCalledTimes(29);
    expect(evalCallsForMarker(runner, "due-timer-fired-and-modal-visible")).toHaveLength(0);
    expectVerifiedSnapshotCleanup(runner);
  });

  it("uses the longer bound only when the matching due modal never appears", async () => {
    const runner = fakeRunner({ falseEvalMarkers: ["due-timer-fired-and-modal-visible"] });
    const wait = vi.fn(() => Promise.resolve());

    await expect(runObsidianSmoke(options(), dependencies(runner, { wait }))).rejects.toThrow(/Focus catch-up due timer and matching alert modal/);

    expect(evalCallsForMarker(runner, "due-timer-active-persisted")).toHaveLength(1);
    expect(evalCallsForMarker(runner, "due-timer-fired-and-modal-visible")).toHaveLength(150);
    expect(wait).toHaveBeenCalledTimes(150);
    expect(evalCallsForMarker(runner, "dismiss-due-alert")).toHaveLength(0);
    expectVerifiedSnapshotCleanup(runner);
  });

  it("restores safely when the matching alert has no Stop control", async () => {
    const runner = fakeRunner({ falseEvalMarkers: ["dismiss-due-alert"] });

    await expect(runObsidianSmoke(options(), dependencies(runner))).rejects.toThrow(/Due-alert stop control/);

    expect(evalCallsForMarker(runner, "dismiss-due-alert")).toHaveLength(1);
    expect(evalCallsForMarker(runner, "due-alert-dismissed")).toHaveLength(0);
    expectVerifiedSnapshotCleanup(runner);
  });

  it("bounds a failed post-dismiss assertion and restores safely", async () => {
    const runner = fakeRunner({ falseEvalMarkers: ["due-alert-dismissed"] });
    const wait = vi.fn(() => Promise.resolve());

    await expect(runObsidianSmoke(options(), dependencies(runner, { wait }))).rejects.toThrow(/Stopped due-alert completion/);

    expect(evalCallsForMarker(runner, "due-alert-dismissed")).toHaveLength(30);
    expect(wait).toHaveBeenCalledTimes(30);
    expectVerifiedSnapshotCleanup(runner);
  });

  it("continues quiescence and verified restoration after cleanup dismissal fails", async () => {
    const runner = fakeRunner();
    const runProcess = vi.fn(async (file, args, commandOptions) => {
      const result = await runner.runProcess(file, args, commandOptions);
      if (args[1] === "command" && args[2] === "id=alarm-timer:dismiss-ringing-alert") {
        throw new Error("mock cleanup dismiss failed");
      }
      return result;
    });
    let thrown;

    try {
      await runObsidianSmoke(options(), dependencies(runner, { runProcess }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    if (!(thrown instanceof AggregateError)) throw new Error("Expected cleanup dismissal failure.");
    expect(thrown).toMatchObject({ message: "Obsidian smoke cleanup failed." });
    expect(thrown.errors).toEqual(expect.arrayContaining([expect.objectContaining({ message: "mock cleanup dismiss failed" })]));
    expectVerifiedSnapshotCleanup(runner);
  });

  it("stops before UI mutation if the renderer snapshot does not survive plugin reload", async () => {
    const runner = fakeRunner({ falseEvalMarkers: ["verify-snapshot-survived-reload"] });

    await expect(runObsidianSmoke(options(), dependencies(runner))).rejects.toThrow(/reload survival/);

    const markers = runner.calls.filter((call) => call.args[1] === "eval").map((call) => evalMarker(call.args));
    expect(markers).not.toContain("select-timer-tab");
    expect(runner.wasDataRestored()).toBe(true);
    expect(runner.wasSnapshotDeleted()).toBe(true);
    expect(runner.hasSnapshot()).toBe(false);
  });

  it("restores plugin data when the persistence reload fails", async () => {
    const runner = fakeRunner();
    let reloadCount = 0;
    const runProcess = vi.fn(async (file, args, commandOptions) => {
      if (args[1] === "plugin:reload" && ++reloadCount === 2) throw new Error("mock persistence reload failed");
      return runner.runProcess(file, args, commandOptions);
    });

    await expect(runObsidianSmoke(options(), dependencies(runner, { runProcess }))).rejects.toThrow("mock persistence reload failed");

    expect(runner.wasDataRestored()).toBe(true);
    expect(runner.wasSnapshotDeleted()).toBe(true);
    expect(runner.calls.filter((call) => call.args[1] === "eval").map((call) => evalMarker(call.args))).toContain("verify-plugin-data-restored");
  });

  it("skips restoration after quiescence fails while completing safe cleanup", async () => {
    const runner = fakeRunner({ throwEvalMarkers: ["quiesce-plugin-data-writes"] });
    const log = vi.fn();
    let thrown;

    try {
      await runObsidianSmoke(options(), dependencies(runner, { log }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    if (!(thrown instanceof Error)) throw new Error("Expected quiescence cleanup failure.");
    expect(thrown.message).toMatch(/cleanup failed/);
    expect(thrown.message).not.toContain(PRESERVED_FIXTURE_TEXT);
    expect(log.mock.calls.flat().join("\n")).not.toContain(PRESERVED_FIXTURE_TEXT);
    const markers = runner.calls.filter((call) => call.args[1] === "eval").map((call) => evalMarker(call.args));
    expect(markers).toContain("quiesce-plugin-data-writes");
    expect(markers).not.toContain("restore-plugin-data");
    expect(markers).not.toContain("verify-plugin-data-restored");
    expect(markers).toContain("delete-plugin-data-snapshot");
    expect(runner.wasDataRestored()).toBe(false);
    expect(runner.wasSnapshotDeleted()).toBe(true);
    expect(runner.hasSnapshot()).toBe(false);
  });

  it("reports restoration failure", async () => {
    const runner = fakeRunner({ throwEvalMarkers: ["restore-plugin-data"] });

    await expect(runObsidianSmoke(options(), dependencies(runner))).rejects.toThrow(/cleanup failed/);

    expect(runner.wasDataRestored()).toBe(false);
    expect(runner.wasSnapshotDeleted()).toBe(true);
    expect(runner.calls.filter((call) => call.args[1] === "eval").map((call) => evalMarker(call.args))).not.toContain("verify-plugin-data-restored");
  });

  it("reports snapshot deletion failure after verified restoration", async () => {
    const runner = fakeRunner({ falseEvalMarkers: ["delete-plugin-data-snapshot"] });

    await expect(runObsidianSmoke(options(), dependencies(runner))).rejects.toThrow(/cleanup failed/);

    expect(runner.wasDataRestored()).toBe(true);
    expect(runner.wasSnapshotDeleted()).toBe(false);
    expect(runner.hasSnapshot()).toBe(true);
  });

  it("deletes the renderer snapshot after restoration verification fails", async () => {
    const runner = fakeRunner({ falseEvalMarkers: ["verify-plugin-data-restored"] });

    await expect(runObsidianSmoke(options(), dependencies(runner))).rejects.toThrow(/cleanup failed/);

    expect(runner.wasDataRestored()).toBe(true);
    expect(runner.wasSnapshotDeleted()).toBe(true);
    expect(runner.hasSnapshot()).toBe(false);
  });

  it("rejects a screenshot inside the vault before spawning", async () => {
    await expectScreenshotPreflightFailure(join(vaultPath, "smoke.png"), /outside/);
  });

  it("rejects an existing final-component file symlink without changing its target", async () => {
    const outputDirectory = join(temporaryRoot, "Screenshot Output");
    const target = join(outputDirectory, "preserved.png");
    const screenshotPath = join(outputDirectory, "linked.png");
    await mkdir(outputDirectory);
    await writeFile(target, "preserved screenshot target");
    await symlink(target, screenshotPath, "file");

    await expectScreenshotPreflightFailure(screenshotPath, /regular, non-symlink file/);

    expect(await readFile(target, "utf8")).toBe("preserved screenshot target");
  });

  it("rejects a final-component symlink whose target is inside the vault", async () => {
    const outputDirectory = join(temporaryRoot, "Screenshot Output");
    const target = join(vaultPath, "vault-target.png");
    const screenshotPath = join(outputDirectory, "linked-into-vault.png");
    await mkdir(outputDirectory);
    await writeFile(target, "vault target");
    await symlink(target, screenshotPath, "file");

    await expectScreenshotPreflightFailure(screenshotPath, /regular, non-symlink file/);
  });

  it("rejects an existing non-regular screenshot target", async () => {
    const screenshotPath = join(temporaryRoot, "screenshot-directory");
    await mkdir(screenshotPath);

    await expectScreenshotPreflightFailure(screenshotPath, /regular, non-symlink file/);
  });

  it("allows a missing outside target and passes its canonical path to the CLI", async () => {
    const outputDirectory = join(temporaryRoot, "Screenshot Output");
    await mkdir(outputDirectory);
    const screenshotPath = `${outputDirectory}${sep}.${sep}missing.png`;
    const canonicalScreenshot = join(await realpath(outputDirectory), "missing.png");
    const runner = fakeRunner();

    await runObsidianSmoke(options({ screenshotPath }), dependencies(runner));

    const screenshotCall = runner.calls.find((call) => call.args[1] === "dev:screenshot");
    expect(screenshotCall?.args).toContain(`path=${canonicalScreenshot}`);
    expect(screenshotCall?.args).not.toContain(`path=${screenshotPath}`);
  });

  it("allows an existing regular outside target and passes its canonical path to the CLI", async () => {
    const outputDirectory = join(temporaryRoot, "Screenshot Output");
    const screenshotPath = join(outputDirectory, "existing.png");
    await mkdir(outputDirectory);
    await writeFile(screenshotPath, "existing screenshot");
    const canonicalScreenshot = join(await realpath(outputDirectory), "existing.png");
    const runner = fakeRunner();

    await runObsidianSmoke(options({ screenshotPath }), dependencies(runner));

    const screenshotCall = runner.calls.find((call) => call.args[1] === "dev:screenshot");
    expect(screenshotCall?.args).toContain(`path=${canonicalScreenshot}`);
  });
});
