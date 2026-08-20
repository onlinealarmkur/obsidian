import { constants as fsConstants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DISPOSABLE_SENTINEL,
  installTestVault,
  PLUGIN_ID,
  rejectUnsafeResolvedPath,
  validateDisposableVaultSentinel
} from "./install-test-vault.mjs";

export { DISPOSABLE_SENTINEL };
const ROOT_SELECTOR = ".online-alarm-timer-view";
const ACTIVE_ITEMS_SELECTOR = "#online-alarm-timer-active-items";
const COMPLETED_ITEMS_SELECTOR = "#online-alarm-timer-completed-items";
const DUE_ALERT_EVAL_ATTEMPTS = 150;
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const SMOKE_EXPECTATIONS = Object.freeze({
  en: { heading: "Alarm and Timer", alarm: "Alarm", timer: "Timer", edit: "Edit", cancel: "Cancel", pause: "Pause", resume: "Resume", restart: "Restart", stop: "Stop", completed: "Completed", cancelled: "Cancelled" },
  zh: { heading: "Alarm and Timer", alarm: "提醒", timer: "计时器", edit: "编辑", cancel: "取消", pause: "暂停", resume: "继续", restart: "重新开始", stop: "停止", completed: "已完成", cancelled: "已取消" },
  ru: { heading: "Alarm and Timer", alarm: "Сигнал", timer: "Таймер", edit: "Изменить", cancel: "Отменить", pause: "Приостановить", resume: "Продолжить", restart: "Запустить заново", stop: "Остановить", completed: "Завершено", cancelled: "Отменено" },
  ja: { heading: "Alarm and Timer", alarm: "アラーム", timer: "タイマー", edit: "編集", cancel: "キャンセル", pause: "一時停止", resume: "再開", restart: "最初から", stop: "停止", completed: "完了", cancelled: "キャンセル済み" },
  de: { heading: "Alarm and Timer", alarm: "Alarm", timer: "Timer", edit: "Bearbeiten", cancel: "Abbrechen", pause: "Pausieren", resume: "Fortsetzen", restart: "Neu starten", stop: "Stoppen", completed: "Abgeschlossen", cancelled: "Abgebrochen" },
  pt: { heading: "Alarm and Timer", alarm: "Alarme", timer: "Temporizador", edit: "Editar", cancel: "Cancelar", pause: "Pausar", resume: "Retomar", restart: "Reiniciar", stop: "Parar", completed: "Concluído", cancelled: "Cancelado" },
  tr: { heading: "Alarm and Timer", alarm: "Alarm", timer: "Zamanlayıcı", edit: "Düzenle", cancel: "İptal et", pause: "Duraklat", resume: "Devam et", restart: "Yeniden başlat", stop: "Durdur", completed: "Tamamlandı", cancelled: "İptal edildi" }
});

export const HELP_TEXT = `Usage:
  npm run obsidian:smoke -- --vault <absolute-path> --cli <absolute-path> [--obsidian-vault <name-or-id>] [--screenshot <absolute-path>] [--expected-language <code>]

Safety requirements:
  --vault must be an explicit disposable vault containing .obsidian/ and ${DISPOSABLE_SENTINEL}.
  --obsidian-vault is optional. When omitted, the CLI runs from the exact --vault directory,
  which Obsidian officially uses as the target vault. When supplied, it is used as the
  explicit vault name or ID.
  --cli must be an absolute path to an executable Obsidian CLI.
  --expected-language may be en, zh, ru, ja, de, pt, or tr and defaults to en.
  The plugin must already be enabled. This command never discovers or enables a vault or plugin,
  and it verifies the CLI-reported canonical vault path before building or changing plugin files.
`;

function takeValue(args, index, name) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

export function parseSmokeArguments(args) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { help: true };
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") throw new Error("Use --help by itself.");
    const names = ["--vault", "--obsidian-vault", "--cli", "--screenshot", "--expected-language"];
    const name = names.find((candidate) => argument === candidate || argument?.startsWith(`${candidate}=`));
    if (name === undefined) throw new Error(`Unknown smoke-test argument: ${argument ?? ""}`);
    if (values.has(name)) throw new Error(`Specify ${name} only once.`);
    if (argument === name) {
      values.set(name, takeValue(args, index, name));
      index += 1;
    } else {
      const value = argument?.slice(name.length + 1) ?? "";
      if (value === "") throw new Error(`${name} requires a value.`);
      values.set(name, value);
    }
  }

  for (const required of ["--vault", "--cli"]) {
    if (!values.has(required)) throw new Error(`${required} is required.`);
  }
  const vaultPath = values.get("--vault");
  const cliPath = values.get("--cli");
  const screenshotPath = values.get("--screenshot");
  const expectedLanguage = values.get("--expected-language");
  if (vaultPath === undefined || !isAbsolute(vaultPath)) throw new Error("--vault must be an absolute path.");
  if (cliPath === undefined || !isAbsolute(cliPath)) throw new Error("--cli must be an absolute path.");
  if (screenshotPath !== undefined && !isAbsolute(screenshotPath)) throw new Error("--screenshot must be an absolute path.");
  if (expectedLanguage !== undefined && !(expectedLanguage in SMOKE_EXPECTATIONS)) {
    throw new Error("--expected-language must be one of: en, zh, ru, ja, de, pt, tr.");
  }
  const obsidianVault = values.get("--obsidian-vault")?.trim();
  if (values.has("--obsidian-vault") && obsidianVault === "") throw new Error("--obsidian-vault cannot be empty.");
  return { help: false, vaultPath, obsidianVault, cliPath, screenshotPath, expectedLanguage };
}

function isMissing(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function lstatIfExists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function requireDirectory(path, label) {
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined || !info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} must be an existing real directory: ${path}`);
  }
}

async function validateCli(path) {
  const canonicalPath = await realpath(path).catch(() => undefined);
  const info = canonicalPath === undefined ? undefined : await lstat(canonicalPath).catch(() => undefined);
  if (canonicalPath === undefined || info === undefined || !info.isFile()) {
    throw new Error(`--cli must resolve to an existing regular file: ${path}`);
  }
  await access(canonicalPath, fsConstants.X_OK).catch(() => {
    throw new Error(`--cli must be executable: ${path}`);
  });
  // Validate the real target, but invoke the exact path supplied by the user.
  // Obsidian's registered macOS CLI is a symlink and its launcher behavior
  // depends on being entered through that registered path.
  return path;
}

function isInside(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}

async function validateScreenshotPath(path, canonicalVault) {
  const parent = dirname(path);
  await requireDirectory(parent, "Screenshot parent directory");
  const canonicalPath = resolve(await realpath(parent), basename(path));
  const info = await lstatIfExists(canonicalPath);
  if (info !== undefined && (info.isSymbolicLink() || !info.isFile())) {
    throw new Error(`--screenshot must be missing or an existing regular, non-symlink file: ${path}`);
  }
  if (isInside(canonicalVault, canonicalPath)) throw new Error("--screenshot must be outside the disposable vault.");
  return canonicalPath;
}

function hasPluginId(output) {
  try {
    const value = JSON.parse(output);
    const contains = (entry) => {
      if (entry === PLUGIN_ID) return true;
      if (Array.isArray(entry)) return entry.some(contains);
      if (entry !== null && typeof entry === "object") return Object.values(entry).some(contains);
      return false;
    };
    if (contains(value)) return true;
  } catch {
    // The CLI's default format is text; JSON is accepted only when returned.
  }
  return output.split(/\r?\n/u).some((line) => line.split(/[\s,\t]+/u).includes(PLUGIN_ID));
}

function hasDeveloperErrors(output) {
  const trimmed = output.trim();
  if (trimmed === "" || /^no (?:(?:captured )?(?:javascript )?errors|errors captured)\.?$/iu.test(trimmed)) return false;
  try {
    const value = JSON.parse(trimmed);
    return !Array.isArray(value) || value.length > 0;
  } catch {
    return true;
  }
}

function parseBoolean(output, label) {
  const value = output
    .trim()
    .replace(/^=>\s*/u, "")
    .replace(/^"|"$/gu, "");
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${label} returned an unexpected value: ${output.trim()}`);
}

export function formatSmokeError(error) {
  if (error instanceof AggregateError) {
    const details = error.errors
      .map((nestedError, index) => `${index + 1}. ${formatSmokeError(nestedError)}`)
      .join("\n");
    return details === "" ? error.message : `${error.message}\n${details}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function markedEval(marker, code) {
  return `/* alarm-timer-smoke:${marker} */${code}`;
}

function pluginAccess(operation) {
  // Official CLI eval has no public plugin-instance or plugin-data command. This test-only lookup runs only after the explicit disposable-vault and pre-enabled-plugin guards.
  return `(async()=>{const plugin=app.plugins.getPlugin(${JSON.stringify(PLUGIN_ID)});if(plugin===null||plugin===undefined||typeof plugin.${operation}!=="function")throw new Error("Alarm and Timer plugin data API is unavailable.");`;
}

function cardLookup(label, hostSelector = ACTIVE_ITEMS_SELECTOR) {
  return `const root=document.querySelector(${JSON.stringify(ROOT_SELECTOR)});const card=[...(root?.querySelectorAll(${JSON.stringify(`${hostSelector} .online-alarm-timer-card`)})??[])].find((candidate)=>candidate.querySelector("strong")?.textContent?.trim()===${JSON.stringify(label)});`;
}

function requireDomMatch(output, mode) {
  const count = Number.parseInt(output.trim(), 10);
  if (!Number.isInteger(count) || count < 1) throw new Error(`The ${mode} smoke check did not find ${ROOT_SELECTOR}.`);
}

export async function defaultRunProcess(file, args, options = {}) {
  try {
    const result = await execFileAsync(file, args, {
      cwd: options.cwd,
      encoding: "utf8",
      killSignal: "SIGKILL",
      maxBuffer: 10 * 1024 * 1024,
      timeout: options.timeout ?? 60_000
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const stderr = error !== null && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
    const stdout = error !== null && typeof error === "object" && "stdout" in error ? String(error.stdout) : "";
    let detail = stderr.trim() || stdout.trim() || (error instanceof Error ? error.message : String(error));
    for (const argument of args) {
      if (!argument.startsWith("code=")) continue;
      detail = detail.replaceAll(argument, "code=<redacted>");
      const payload = argument.slice("code=".length);
      if (payload !== "") detail = detail.replaceAll(payload, "<redacted>");
    }
    const displayArgs = args.map((argument) => argument.startsWith("code=") ? "code=<redacted>" : argument);
    throw new Error(`Command failed: ${file} ${displayArgs.join(" ")}\n${detail}`);
  }
}

export async function runObsidianSmoke(options, dependencies = {}) {
  const runProcess = dependencies.runProcess ?? defaultRunProcess;
  const install = dependencies.install ?? installTestVault;
  const build = dependencies.build ?? (async () => {
    const npmExecPath = process.env.npm_execpath;
    if (npmExecPath === undefined) await runProcess("npm", ["run", "build"], { cwd: PROJECT_ROOT });
    else await runProcess(process.execPath, [npmExecPath, "run", "build"], { cwd: PROJECT_ROOT });
  });
  const log = dependencies.log ?? ((message) => process.stdout.write(`${message}\n`));
  const wait = dependencies.wait ?? ((milliseconds) => delay(milliseconds));
  const workflowLabel = dependencies.workflowLabel ?? `alarm-timer-smoke-${Date.now()}-${process.pid}`;
  const alarmLabel = `${workflowLabel}-alarm`;
  const editedAlarmLabel = `${alarmLabel}-edited`;
  const dueTimerLabel = `${workflowLabel}-due-alert`;
  const snapshotKey = dependencies.snapshotKey ?? `__alarmTimerSmokeSnapshot_${workflowLabel}_${Date.now()}_${process.pid}`;
  const expectedLanguage = options.expectedLanguage ?? "en";
  const labels = SMOKE_EXPECTATIONS[expectedLanguage];

  await requireDirectory(options.vaultPath, "--vault");
  rejectUnsafeResolvedPath(resolve(options.vaultPath));
  const canonicalVault = await realpath(options.vaultPath);
  rejectUnsafeResolvedPath(canonicalVault);
  await requireDirectory(resolve(canonicalVault, ".obsidian"), "Disposable vault .obsidian directory");
  await validateDisposableVaultSentinel(canonicalVault);
  const cliExecutable = await validateCli(options.cliPath);
  const canonicalScreenshot = options.screenshotPath === undefined
    ? undefined
    : await validateScreenshotPath(options.screenshotPath, canonicalVault);

  const cli = async (...args) => {
    const vaultArgument = options.obsidianVault === undefined ? [] : [`vault=${options.obsidianVault}`];
    const result = await runProcess(cliExecutable, [...vaultArgument, ...args], { cwd: canonicalVault });
    return result.stdout;
  };
  const evaluate = (marker, code) => cli("eval", `code=${markedEval(marker, code)}`);
  const requireEvalTrue = async (marker, code, description) => {
    if (!parseBoolean(await evaluate(marker, code), description)) throw new Error(`${description} failed.`);
  };
  const waitForEval = async (marker, code, description, attempts = 30) => {
    for (let attempt = 0; attempt < attempts; ++attempt) {
      if (parseBoolean(await evaluate(marker, code), description)) return;
      if (attempt < attempts - 1) await wait(100);
    }
    throw new Error(`${description} did not become true.`);
  };

  const reportedVault = (await cli("vault", "info=path")).trim();
  if (!isAbsolute(reportedVault)) throw new Error(`Obsidian CLI returned a non-absolute vault path: ${reportedVault}`);
  const canonicalReportedVault = await realpath(reportedVault).catch(() => undefined);
  if (canonicalReportedVault === undefined || canonicalReportedVault !== canonicalVault) {
    throw new Error(`Obsidian CLI vault mismatch. Expected ${canonicalVault}; received ${reportedVault}.`);
  }
  const enabledPlugins = await cli("plugins:enabled", "filter=community");
  if (!hasPluginId(enabledPlugins)) {
    throw new Error(`Plugin ${PLUGIN_ID} must already be enabled in the explicit disposable vault. The smoke test will not enable it.`);
  }

  const deleteSnapshot = () => requireEvalTrue(
    "delete-plugin-data-snapshot",
    `(()=>{sessionStorage.removeItem(${JSON.stringify(snapshotKey)});return sessionStorage.getItem(${JSON.stringify(snapshotKey)})===null;})()`,
    "Plugin-data snapshot deletion"
  );
  try {
    await requireEvalTrue(
      "snapshot-plugin-data",
      `${pluginAccess("loadData")}const snapshot=JSON.stringify(await plugin.loadData());if(typeof snapshot!=="string")throw new Error("Alarm and Timer plugin data could not be serialized.");sessionStorage.setItem(${JSON.stringify(snapshotKey)},snapshot);return sessionStorage.getItem(${JSON.stringify(snapshotKey)})===snapshot;})()`,
      "Plugin-data snapshot"
    );
  } catch (error) {
    try {
      await deleteSnapshot();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Obsidian smoke snapshot and cleanup both failed.");
    }
    throw error;
  }
  let workflowError;
  try {
    await build();
    await install({ vaultPath: canonicalVault, sourceRoot: PROJECT_ROOT, log });
    const initialErrors = await cli("dev:errors");
    await cli("plugin:reload", `id=${PLUGIN_ID}`);
    await requireEvalTrue(
      "verify-snapshot-survived-reload",
      `typeof sessionStorage.getItem(${JSON.stringify(snapshotKey)})==="string"`,
      "Plugin-data snapshot reload survival"
    );
    await requireEvalTrue(
      "verify-plugin-language",
      `(()=>{const plugin=app.plugins.getPlugin(${JSON.stringify(PLUGIN_ID)});return plugin?.i18n?.language===${JSON.stringify(expectedLanguage)};})()`,
      `Plugin language ${expectedLanguage}`
    );

    await cli("command", `id=${PLUGIN_ID}:open-view`);
    requireDomMatch(await cli("dev:dom", `selector=${ROOT_SELECTOR}`, "total"), "desktop");
    await requireEvalTrue(
      "localized-shell",
      `(()=>{const root=document.querySelector(${JSON.stringify(ROOT_SELECTOR)});return root?.querySelector(".online-alarm-timer-heading")?.textContent?.trim()===${JSON.stringify(labels.heading)}&&root?.querySelector("#online-alarm-timer-alarm-tab")?.textContent?.trim()===${JSON.stringify(labels.alarm)}&&root?.querySelector("#online-alarm-timer-timer-tab")?.textContent?.trim()===${JSON.stringify(labels.timer)};})()`,
      `Localized ${expectedLanguage} shell`
    );

    await requireEvalTrue(
      "select-alarm-tab",
      `(()=>{const button=document.querySelector(${JSON.stringify(`${ROOT_SELECTOR} #online-alarm-timer-alarm-tab`)});if(button===null)return false;button.click();return true;})()`,
      "Alarm-tab selection"
    );
    await requireEvalTrue(
      "create-alarm",
      `(()=>{const root=document.querySelector(${JSON.stringify(ROOT_SELECTOR)});const form=root?.querySelector("form.online-alarm-timer-form");const time=root?.querySelector("#online-alarm-timer-view-alarm-time");const date=root?.querySelector("#online-alarm-timer-view-alarm-date");const label=root?.querySelector("#online-alarm-timer-view-alarm-label");if(form===null||form===undefined||time===null||time===undefined||date===null||date===undefined||label===null||label===undefined||typeof form.requestSubmit!=="function")return false;const target=new Date(Date.now()+15*60000);time.value=\`\${String(target.getHours()).padStart(2,"0")}:\${String(target.getMinutes()).padStart(2,"0")}\`;date.value=\`\${target.getFullYear()}-\${String(target.getMonth()+1).padStart(2,"0")}-\${String(target.getDate()).padStart(2,"0")}\`;label.value=${JSON.stringify(alarmLabel)};form.requestSubmit();return true;})()`,
      "Alarm creation"
    );
    await waitForEval(
      "created-alarm-visible",
      `(()=>{${cardLookup(alarmLabel)}return card!==undefined;})()`,
      "Created alarm card"
    );
    await requireEvalTrue(
      "alarm-actions-match",
      `(()=>{${cardLookup(alarmLabel)}const actions=[...(card?.querySelectorAll(".online-alarm-timer-actions button")??[])].map((button)=>button.textContent?.trim());return JSON.stringify(actions)===JSON.stringify(${JSON.stringify([labels.edit, labels.cancel])});})()`,
      "Alarm action model"
    );
    await requireEvalTrue(
      "edit-alarm",
      `(()=>{${cardLookup(alarmLabel)}const edit=[...(card?.querySelectorAll("button")??[])].find((button)=>button.textContent?.trim()===${JSON.stringify(labels.edit)});if(edit===undefined)return false;edit.click();const modal=document.querySelector(".online-alarm-timer-edit-modal");const form=modal?.querySelector("form");const time=modal?.querySelector("#online-alarm-timer-edit-alarm-time");const date=modal?.querySelector("#online-alarm-timer-edit-alarm-date");const label=modal?.querySelector("#online-alarm-timer-edit-alarm-label");if(form===null||form===undefined||time===null||time===undefined||date===null||date===undefined||label===null||label===undefined||typeof form.requestSubmit!=="function")return false;const target=new Date(Date.now()+30*60000);time.value=\`\${String(target.getHours()).padStart(2,"0")}:\${String(target.getMinutes()).padStart(2,"0")}\`;date.value=\`\${target.getFullYear()}-\${String(target.getMonth()+1).padStart(2,"0")}-\${String(target.getDate()).padStart(2,"0")}\`;label.value=${JSON.stringify(editedAlarmLabel)};form.requestSubmit();return true;})()`,
      "Alarm edit action"
    );
    await waitForEval(
      "edited-alarm-persisted",
      `${pluginAccess("loadData")}const data=await plugin.loadData();const item=data?.items?.find((candidate)=>candidate.label===${JSON.stringify(editedAlarmLabel)});const remaining=(item?.targetAt??0)-Date.now();return item?.type==="alarm"&&item.status==="active"&&remaining>25*60000&&remaining<=30*60000;})()`,
      "Edited alarm persistence"
    );
    await requireEvalTrue(
      "force-alarm-catch-up",
      `${pluginAccess("loadData")}const data=await plugin.loadData();const item=data?.items?.find((candidate)=>candidate.label===${JSON.stringify(editedAlarmLabel)});if(item?.type!=="alarm"||plugin.items===undefined||plugin.scheduler===undefined)return false;const updated=await plugin.items.updateAlarm(item.id,Date.now()-1000,${JSON.stringify(editedAlarmLabel)});if(!updated)return false;await plugin.scheduler.check();return true;})()`,
      "Alarm catch-up scheduling"
    );
    await waitForEval(
      "alarm-fired-and-modal-visible",
      `${pluginAccess("loadData")}const data=await plugin.loadData();const item=data?.items?.find((candidate)=>candidate.label===${JSON.stringify(editedAlarmLabel)});const modal=[...document.querySelectorAll(".online-alarm-timer-alert-modal")].find((candidate)=>candidate.querySelector(".online-alarm-timer-alert-label")?.textContent?.trim()===${JSON.stringify(editedAlarmLabel)});const actions=[...(modal?.querySelectorAll("button")??[])].map((button)=>button.textContent?.trim());return item?.type==="alarm"&&item.status==="fired"&&Number.isFinite(item.firedAt)&&JSON.stringify(actions)===JSON.stringify(${JSON.stringify([labels.stop])});})()`,
      "Scheduler-fired alarm and matching Stop-only modal"
    );
    await requireEvalTrue(
      "dismiss-alarm-alert",
      `(()=>{const modal=[...document.querySelectorAll(".online-alarm-timer-alert-modal")].find((candidate)=>candidate.querySelector(".online-alarm-timer-alert-label")?.textContent?.trim()===${JSON.stringify(editedAlarmLabel)});const button=[...(modal?.querySelectorAll("button")??[])].find((candidate)=>candidate.textContent?.trim()===${JSON.stringify(labels.stop)});if(button===undefined)return false;button.click();return true;})()`,
      "Alarm-alert Stop control"
    );
    await waitForEval(
      "alarm-alert-completed",
      `${pluginAccess("loadData")}const data=await plugin.loadData();const item=data?.items?.find((candidate)=>candidate.label===${JSON.stringify(editedAlarmLabel)});const modal=[...document.querySelectorAll(".online-alarm-timer-alert-modal")].find((candidate)=>candidate.querySelector(".online-alarm-timer-alert-label")?.textContent?.trim()===${JSON.stringify(editedAlarmLabel)});${cardLookup(editedAlarmLabel, COMPLETED_ITEMS_SELECTOR)}return modal===undefined&&item?.type==="alarm"&&item.status==="completed"&&Number.isFinite(item.completedAt)&&card?.querySelector(".online-alarm-timer-state")?.textContent?.trim()===${JSON.stringify(labels.completed)};})()`,
      "Durable alarm completion"
    );
    await cli("plugin:reload", `id=${PLUGIN_ID}`);
    await cli("command", `id=${PLUGIN_ID}:open-view`);
    await waitForEval(
      "alarm-completion-survived-reload",
      `${pluginAccess("loadData")}const data=await plugin.loadData();const item=data?.items?.find((candidate)=>candidate.label===${JSON.stringify(editedAlarmLabel)});const modal=[...document.querySelectorAll(".online-alarm-timer-alert-modal")].find((candidate)=>candidate.querySelector(".online-alarm-timer-alert-label")?.textContent?.trim()===${JSON.stringify(editedAlarmLabel)});return item?.type==="alarm"&&item.status==="completed"&&modal===undefined;})()`,
      "Completed alarm reload persistence"
    );

    await requireEvalTrue(
      "select-timer-tab",
      `(()=>{const button=document.querySelector(${JSON.stringify(`${ROOT_SELECTOR} #online-alarm-timer-timer-tab`)});if(button===null)return false;button.click();return true;})()`,
      "Timer-tab selection"
    );
    await requireEvalTrue(
      "create-timer",
      `(()=>{const form=document.querySelector(${JSON.stringify(`${ROOT_SELECTOR} form.online-alarm-timer-form`)});const duration=document.querySelector("#online-alarm-timer-view-timer-duration");const label=document.querySelector("#online-alarm-timer-view-timer-label");if(form===null||duration===null||label===null||typeof form.requestSubmit!=="function")return false;duration.value="30m";duration.dispatchEvent(new Event("input",{bubbles:true}));label.value=${JSON.stringify(workflowLabel)};label.dispatchEvent(new Event("input",{bubbles:true}));form.requestSubmit();return true;})()`,
      "Timer creation"
    );
    await waitForEval(
      "created-timer-visible",
      `(()=>{${cardLookup(workflowLabel)}return card!==undefined;})()`,
      "Created timer card"
    );

    await requireEvalTrue(
      "timer-actions-match",
      `(()=>{${cardLookup(workflowLabel)}const actions=[...(card?.querySelectorAll(".online-alarm-timer-actions button")??[])].map((button)=>button.textContent?.trim());return JSON.stringify(actions)===JSON.stringify(${JSON.stringify([labels.pause, labels.restart, labels.cancel])});})()`,
      "Timer action model"
    );

    await requireEvalTrue(
      "pause-timer",
      `(()=>{${cardLookup(workflowLabel)}const button=[...(card?.querySelectorAll("button")??[])].find((candidate)=>candidate.textContent?.trim()===${JSON.stringify(labels.pause)});if(button===undefined)return false;button.click();return true;})()`,
      "Timer pause action"
    );
    await waitForEval(
      "paused-timer-persisted",
      `${pluginAccess("loadData")}const data=await plugin.loadData();return data?.items?.some((item)=>item.label===${JSON.stringify(workflowLabel)}&&item.type==="timer"&&item.status==="paused"&&item.durationMs===1800000);})()`,
      "Paused timer persistence"
    );
    await requireEvalTrue(
      "resume-timer",
      `(()=>{${cardLookup(workflowLabel)}const button=[...(card?.querySelectorAll("button")??[])].find((candidate)=>candidate.textContent?.trim()===${JSON.stringify(labels.resume)});if(button===undefined)return false;button.click();return true;})()`,
      "Timer resume action"
    );
    await waitForEval(
      "resumed-timer-persisted",
      `${pluginAccess("loadData")}const data=await plugin.loadData();return data?.items?.some((item)=>item.label===${JSON.stringify(workflowLabel)}&&item.type==="timer"&&item.status==="active"&&item.durationMs===1800000);})()`,
      "Resumed timer persistence"
    );
    await requireEvalTrue(
      "restart-timer",
      `(()=>{${cardLookup(workflowLabel)}const button=[...(card?.querySelectorAll("button")??[])].find((candidate)=>candidate.textContent?.trim()===${JSON.stringify(labels.restart)});if(button===undefined)return false;button.click();return true;})()`,
      "Timer restart action"
    );
    await waitForEval(
      "restarted-timer-persisted",
      `${pluginAccess("loadData")}const data=await plugin.loadData();const item=data?.items?.find((candidate)=>candidate.label===${JSON.stringify(workflowLabel)});const remaining=(item?.targetAt??0)-Date.now();return item?.type==="timer"&&item.status==="active"&&item.durationMs===1800000&&remaining>1740000&&remaining<=1800000;})()`,
      "Restarted timer persistence"
    );
    await requireEvalTrue(
      "cancel-timer",
      `(()=>{${cardLookup(workflowLabel)}const button=[...(card?.querySelectorAll("button")??[])].find((candidate)=>candidate.textContent?.trim()===${JSON.stringify(labels.cancel)});if(button===undefined)return false;button.click();return true;})()`,
      "Timer cancellation action"
    );
    await waitForEval(
      "cancelled-timer-visible",
      `(()=>{${cardLookup(workflowLabel, COMPLETED_ITEMS_SELECTOR)}return card?.querySelector(".online-alarm-timer-state")?.textContent?.trim()===${JSON.stringify(labels.cancelled)};})()`,
      "Cancelled timer card"
    );

    await cli("plugin:reload", `id=${PLUGIN_ID}`);
    await cli("command", `id=${PLUGIN_ID}:open-view`);
    requireDomMatch(await cli("dev:dom", `selector=${ROOT_SELECTOR}`, "total"), "desktop after reload");
    await waitForEval(
      "cancelled-timer-survived-reload",
      `${pluginAccess("loadData")}const data=await plugin.loadData();const item=data?.items?.find((candidate)=>candidate.label===${JSON.stringify(workflowLabel)});return item?.type==="timer"&&item.status==="cancelled"&&item.durationMs===1800000;})()`,
      "Cancelled timer reload persistence"
    );
    await waitForEval(
      "cancelled-card-survived-reload",
      `(()=>{${cardLookup(workflowLabel, COMPLETED_ITEMS_SELECTOR)}return card?.querySelector(".online-alarm-timer-state")?.textContent?.trim()===${JSON.stringify(labels.cancelled)};})()`,
      "Cancelled timer card after reload"
    );

    await requireEvalTrue(
      "select-due-timer-tab",
      `(()=>{const button=document.querySelector(${JSON.stringify(`${ROOT_SELECTOR} #online-alarm-timer-timer-tab`)});if(button===null)return false;button.click();return true;})()`,
      "Due-timer tab selection"
    );
    await requireEvalTrue(
      "create-due-timer",
      `(()=>{const form=document.querySelector(${JSON.stringify(`${ROOT_SELECTOR} form.online-alarm-timer-form`)});const duration=document.querySelector("#online-alarm-timer-view-timer-duration");const label=document.querySelector("#online-alarm-timer-view-timer-label");if(form===null||duration===null||label===null||typeof form.requestSubmit!=="function")return false;duration.value="5s";duration.dispatchEvent(new Event("input",{bubbles:true}));label.value=${JSON.stringify(dueTimerLabel)};label.dispatchEvent(new Event("input",{bubbles:true}));form.requestSubmit();return true;})()`,
      "Due-timer creation"
    );
    await waitForEval(
      "due-timer-active-persisted",
      `${pluginAccess("loadData")}const data=await plugin.loadData();const item=data?.items?.find((candidate)=>candidate.label===${JSON.stringify(dueTimerLabel)});return item?.type==="timer"&&item.status==="active"&&item.durationMs===5000;})()`,
      "Due-timer active persistence"
    );
    await wait(5_500);
    await requireEvalTrue(
      "wake-due-timer",
      `(()=>{window.dispatchEvent(new Event("focus"));return true;})()`,
      "Due-timer focus wakeup"
    );
    await waitForEval(
      "due-timer-fired-and-modal-visible",
      `${pluginAccess("loadData")}const data=await plugin.loadData();const item=data?.items?.find((candidate)=>candidate.label===${JSON.stringify(dueTimerLabel)});const modal=[...document.querySelectorAll(".online-alarm-timer-alert-modal")].find((candidate)=>candidate.querySelector(".online-alarm-timer-alert-label")?.textContent?.trim()===${JSON.stringify(dueTimerLabel)});return item?.type==="timer"&&item.status==="fired"&&Number.isFinite(item.firedAt)&&modal!==undefined;})()`,
      "Focus catch-up due timer and matching alert modal",
      DUE_ALERT_EVAL_ATTEMPTS
    );
    await requireEvalTrue(
      "dismiss-due-alert",
      `(()=>{const modal=[...document.querySelectorAll(".online-alarm-timer-alert-modal")].find((candidate)=>candidate.querySelector(".online-alarm-timer-alert-label")?.textContent?.trim()===${JSON.stringify(dueTimerLabel)});const actions=[...(modal?.querySelectorAll("button")??[])].map((button)=>button.textContent?.trim());if(JSON.stringify(actions)!==JSON.stringify(${JSON.stringify([labels.restart, labels.stop])}))return false;const button=[...(modal?.querySelectorAll("button")??[])].find((candidate)=>candidate.textContent?.trim()===${JSON.stringify(labels.stop)});if(button===undefined)return false;button.click();return true;})()`,
      "Due-alert stop control"
    );
    await waitForEval(
      "due-alert-dismissed",
      `${pluginAccess("loadData")}const data=await plugin.loadData();const item=data?.items?.find((candidate)=>candidate.label===${JSON.stringify(dueTimerLabel)});const modal=[...document.querySelectorAll(".online-alarm-timer-alert-modal")].find((candidate)=>candidate.querySelector(".online-alarm-timer-alert-label")?.textContent?.trim()===${JSON.stringify(dueTimerLabel)});${cardLookup(dueTimerLabel, COMPLETED_ITEMS_SELECTOR)}return modal===undefined&&card?.querySelector(".online-alarm-timer-state")?.textContent?.trim()===${JSON.stringify(labels.completed)}&&item?.type==="timer"&&item.status==="completed"&&Number.isFinite(item.completedAt);})()`,
      "Stopped due-alert completion"
    );

    if (canonicalScreenshot !== undefined) await cli("dev:screenshot", `path=${canonicalScreenshot}`);
    const errors = await cli("dev:errors");
    if (errors.trim() !== initialErrors.trim() && hasDeveloperErrors(errors)) {
      throw new Error(`Obsidian reported new JavaScript errors after the smoke test:\n${errors.trim()}`);
    }
  } catch (error) {
    workflowError = error;
  }

  const cleanupErrors = [];
  try {
    await cli("command", `id=${PLUGIN_ID}:dismiss-ringing-alert`);
  } catch (error) {
    cleanupErrors.push(error);
  }
  let dataWritesQuiesced = false;
  try {
    await requireEvalTrue(
      "quiesce-plugin-data-writes",
      `${pluginAccess("prepareForDataRestore")}await plugin.prepareForDataRestore();return true;})()`,
      "Plugin-data write quiescence"
    );
    dataWritesQuiesced = true;
  } catch (error) {
    cleanupErrors.push(error);
  }
  let dataRestored = false;
  if (dataWritesQuiesced) {
    try {
      await requireEvalTrue(
        "restore-plugin-data",
        `${pluginAccess("saveData")}const snapshot=sessionStorage.getItem(${JSON.stringify(snapshotKey)});if(typeof snapshot!=="string")throw new Error("Alarm and Timer plugin data snapshot is unavailable.");await plugin.saveData(JSON.parse(snapshot));return true;})()`,
        "Plugin-data restoration"
      );
      dataRestored = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (dataRestored) {
    let reloaded = false;
    try {
      await cli("plugin:reload", `id=${PLUGIN_ID}`);
      reloaded = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (reloaded) {
      try {
        await requireEvalTrue(
          "verify-plugin-data-restored",
          `${pluginAccess("loadData")}const snapshot=sessionStorage.getItem(${JSON.stringify(snapshotKey)});return typeof snapshot==="string"&&JSON.stringify(await plugin.loadData())===snapshot;})()`,
          "Plugin-data restoration verification"
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  try {
    await deleteSnapshot();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (workflowError !== undefined && cleanupErrors.length > 0) {
    throw new AggregateError([workflowError, ...cleanupErrors], "Obsidian smoke workflow and cleanup both failed.");
  }
  if (workflowError !== undefined) throw workflowError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Obsidian smoke cleanup failed.");

  log(`Obsidian smoke test passed for ${canonicalVault}.`);
}

async function runCli() {
  const options = parseSmokeArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }
  await runObsidianSmoke(options);
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await runCli();
  } catch (error) {
    process.stderr.write(`${formatSmokeError(error)}\n`);
    process.exitCode = 1;
  }
}
