import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const PLUGIN_ID = "alarm-timer";
export const RELEASE_ASSETS = ["main.js", "manifest.json", "styles.css"];
export const DISPOSABLE_SENTINEL = ".alarm-timer-disposable-test-vault";
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

function isObsidianInternalPath(path) {
  const name = basename(path);
  if (name === ".obsidian") return true;
  if (name === "plugins" && basename(dirname(path)) === ".obsidian") return true;
  return name === PLUGIN_ID && basename(dirname(path)) === "plugins" && basename(dirname(dirname(path))) === ".obsidian";
}

export function rejectUnsafeResolvedPath(path) {
  if (path === parse(path).root) throw new Error("The filesystem root cannot be used as a test vault.");
  if (path === resolve(homedir())) throw new Error("The home directory cannot be used as a test vault.");
  if (isObsidianInternalPath(path)) throw new Error("Select the vault root, not an Obsidian configuration or plugin directory.");
}

export function parseVaultTarget(args, env = process.env, cwd = process.cwd()) {
  let cliValue;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--vault") {
      if (cliValue !== undefined) throw new Error("Specify --vault only once.");
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--vault requires a path.");
      cliValue = value;
      index += 1;
    } else if (argument?.startsWith("--vault=")) {
      if (cliValue !== undefined) throw new Error("Specify --vault only once.");
      cliValue = argument.slice("--vault=".length);
    } else {
      throw new Error(`Unknown installer argument: ${argument ?? ""}`);
    }
  }

  const environmentValue = env.OBSIDIAN_TEST_VAULT;
  if (cliValue !== undefined && environmentValue !== undefined) {
    throw new Error("Use either --vault or OBSIDIAN_TEST_VAULT, not both.");
  }
  const selected = cliValue ?? environmentValue;
  if (selected === undefined || selected.trim() === "") {
    throw new Error("A disposable test vault is required via --vault or OBSIDIAN_TEST_VAULT.");
  }
  const vaultPath = resolve(cwd, selected);
  rejectUnsafeResolvedPath(vaultPath);
  return vaultPath;
}

async function validateDirectory(path, label) {
  const info = await lstatIfExists(path);
  if (info === undefined || !info.isDirectory()) throw new Error(`${label} must exist and be a directory: ${path}`);
  if (info.isSymbolicLink()) throw new Error(`${label} cannot be a symbolic link: ${path}`);
}

async function validateOptionalDirectory(path, label) {
  const info = await lstatIfExists(path);
  if (info === undefined) return;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory: ${path}`);
}

export async function validateDisposableVaultSentinel(vaultPath) {
  const sentinelPath = join(vaultPath, DISPOSABLE_SENTINEL);
  const info = await lstatIfExists(sentinelPath);
  if (info === undefined || !info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Disposable-vault sentinel is required as a regular file: ${sentinelPath}`);
  }
  const contents = (await readFile(sentinelPath, "utf8")).trim();
  if (contents !== PLUGIN_ID) throw new Error(`Disposable-vault sentinel must contain exactly ${PLUGIN_ID}.`);
}

async function loadReleaseAssets(sourceRoot) {
  const entries = await Promise.all(RELEASE_ASSETS.map(async (asset) => {
    const sourcePath = join(sourceRoot, asset);
    const info = await lstatIfExists(sourcePath);
    if (info === undefined || !info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Release asset must be a regular file: ${sourcePath}`);
    }
    return [asset, await readFile(sourcePath)];
  }));
  const assets = new Map(entries);
  const manifestBuffer = assets.get("manifest.json");
  if (manifestBuffer === undefined) throw new Error("manifest.json is required.");
  let manifest;
  try {
    manifest = JSON.parse(manifestBuffer.toString("utf8"));
  } catch {
    throw new Error("manifest.json must contain valid JSON.");
  }
  if (manifest === null || typeof manifest !== "object" || manifest.id !== PLUGIN_ID) {
    throw new Error(`manifest.json id must be ${PLUGIN_ID}.`);
  }
  return assets;
}

function rejectUnsafeDestinationAsset(path, info) {
  if (info !== undefined && (info.isSymbolicLink() || !info.isFile())) {
    throw new Error(`Destination release asset must be a regular file: ${path}`);
  }
}

async function validateDestinationAssets(destination) {
  for (const asset of RELEASE_ASSETS) {
    const destinationPath = join(destination, asset);
    rejectUnsafeDestinationAsset(destinationPath, await lstatIfExists(destinationPath));
  }
}

async function createTemporaryAsset(destination, asset, content) {
  const temporaryPath = join(destination, `.${PLUGIN_ID}-install-${randomUUID()}-${asset}.tmp`);
  const handle = await open(temporaryPath, "wx", 0o666);
  try {
    await handle.writeFile(content);
    await handle.close();
    return temporaryPath;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function removeIfExists(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function prepareAssetTransaction(destination, assets) {
  const entries = [];
  try {
    for (const asset of RELEASE_ASSETS) {
      const content = assets.get(asset);
      if (content === undefined) throw new Error(`Release asset was not validated: ${asset}`);
      entries.push({
        asset,
        backupPath: undefined,
        destinationPath: join(destination, asset),
        installed: false,
        temporaryPath: await createTemporaryAsset(destination, asset, content)
      });
    }
    return { committed: false, entries };
  } catch (error) {
    const cleanupResults = await Promise.allSettled(entries.map((entry) => removeIfExists(entry.temporaryPath)));
    const cleanupErrors = cleanupResults.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "Release assets could not be staged or cleaned up.");
    }
    throw error;
  }
}

async function commitAssetTransaction(transaction, renameFile) {
  for (const entry of transaction.entries) {
    const destinationInfo = await lstatIfExists(entry.destinationPath);
    rejectUnsafeDestinationAsset(entry.destinationPath, destinationInfo);
    if (destinationInfo === undefined) continue;
    entry.backupPath = join(
      dirname(entry.destinationPath),
      `.${PLUGIN_ID}-install-${randomUUID()}-${basename(entry.destinationPath)}.backup`
    );
    await renameFile(entry.destinationPath, entry.backupPath);
  }

  for (const entry of transaction.entries) {
    const destinationInfo = await lstatIfExists(entry.destinationPath);
    rejectUnsafeDestinationAsset(entry.destinationPath, destinationInfo);
    if (destinationInfo !== undefined) {
      throw new Error(`Destination release asset changed during installation: ${entry.destinationPath}`);
    }
    await renameFile(entry.temporaryPath, entry.destinationPath);
    entry.installed = true;
  }
  transaction.committed = true;

  const cleanupResults = await Promise.allSettled(transaction.entries.map(async (entry) => {
    if (entry.backupPath !== undefined) await removeIfExists(entry.backupPath);
  }));
  const cleanupErrors = cleanupResults.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "Installed release assets, but could not remove every backup.");
}

async function rollbackAssetTransaction(transaction, renameFile) {
  const errors = [];
  for (const entry of transaction.entries) {
    if (!entry.installed) continue;
    try {
      await removeIfExists(entry.destinationPath);
      entry.installed = false;
    } catch (error) {
      errors.push(error);
    }
  }

  for (const entry of transaction.entries) {
    if (entry.backupPath === undefined || await lstatIfExists(entry.backupPath) === undefined) continue;
    try {
      if (await lstatIfExists(entry.destinationPath) !== undefined) {
        throw new Error(`Could not restore release asset because its destination is occupied: ${entry.destinationPath}`);
      }
      await renameFile(entry.backupPath, entry.destinationPath);
    } catch (error) {
      errors.push(error);
    }
  }

  const cleanupResults = await Promise.allSettled(transaction.entries.map((entry) => removeIfExists(entry.temporaryPath)));
  for (const result of cleanupResults) {
    if (result.status === "rejected") errors.push(result.reason);
  }
  return errors;
}

export async function installTestVault({
  vaultPath,
  sourceRoot = PROJECT_ROOT,
  log = (message) => process.stdout.write(`${message}\n`),
  renameFile = rename
}) {
  const resolvedVault = resolve(vaultPath);
  rejectUnsafeResolvedPath(resolvedVault);
  await validateDirectory(resolvedVault, "Test vault");
  const canonicalVault = await realpath(resolvedVault);
  rejectUnsafeResolvedPath(canonicalVault);

  const obsidianDirectory = join(canonicalVault, ".obsidian");
  await validateDirectory(obsidianDirectory, "Test vault .obsidian directory");
  await validateDisposableVaultSentinel(canonicalVault);
  const pluginsDirectory = join(obsidianDirectory, "plugins");
  const destination = join(pluginsDirectory, PLUGIN_ID);
  await validateOptionalDirectory(pluginsDirectory, "Test vault plugins directory");
  await validateOptionalDirectory(destination, "Test plugin directory");

  const assets = await loadReleaseAssets(resolve(sourceRoot));
  await mkdir(destination, { recursive: true });
  await validateDestinationAssets(destination);
  const transaction = await prepareAssetTransaction(destination, assets);
  try {
    await commitAssetTransaction(transaction, renameFile);
  } catch (error) {
    if (transaction.committed) throw error;
    const rollbackErrors = await rollbackAssetTransaction(transaction, renameFile);
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Release asset installation failed and rollback was incomplete."
      );
    }
    throw error;
  }
  for (const asset of RELEASE_ASSETS) {
    log(`Installed ${join(destination, asset)}`);
  }
  return { destination, assets: RELEASE_ASSETS.map((asset) => join(destination, asset)) };
}

async function runCli() {
  const vaultPath = parseVaultTarget(process.argv.slice(2));
  await installTestVault({ vaultPath });
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await runCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
