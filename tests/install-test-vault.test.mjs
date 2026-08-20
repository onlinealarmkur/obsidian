import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import {
  DISPOSABLE_SENTINEL,
  installTestVault,
  parseVaultTarget,
  PLUGIN_ID,
  RELEASE_ASSETS
} from "../scripts/install-test-vault.mjs";

let temporaryRoot;
let sourceRoot;
const FORWARD_RENAME_CALLS = Array.from({ length: RELEASE_ASSETS.length * 2 }, (_, index) => index + 1);

async function createSource(manifestId = PLUGIN_ID) {
  sourceRoot = join(temporaryRoot, "release source");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(join(sourceRoot, "main.js"), "module.exports = {};\n");
  await writeFile(join(sourceRoot, "manifest.json"), `${JSON.stringify({ id: manifestId, version: "1.0.0" })}\n`);
  await writeFile(join(sourceRoot, "styles.css"), ".plugin { color: red; }\n");
}

async function createVault(name = "Disposable Test Vault", includeSentinel = true) {
  const vault = join(temporaryRoot, name);
  await mkdir(join(vault, ".obsidian"), { recursive: true });
  if (includeSentinel) await writeFile(join(vault, DISPOSABLE_SENTINEL), `${PLUGIN_ID}\n`);
  return vault;
}

async function seedExistingDestination(vault) {
  const destination = join(await realpath(vault), ".obsidian", "plugins", PLUGIN_ID);
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, "keep.txt"), "sentinel");
  const oldAssets = new Map();
  for (const asset of RELEASE_ASSETS) {
    const content = `old ${asset}`;
    oldAssets.set(asset, content);
    await writeFile(join(destination, asset), content);
  }
  return { destination, oldAssets };
}

async function expectOldDestination({ destination, oldAssets }) {
  expect(await readFile(join(destination, "keep.txt"), "utf8")).toBe("sentinel");
  for (const [asset, content] of oldAssets) {
    expect(await readFile(join(destination, asset), "utf8")).toBe(content);
  }
  expect((await readdir(destination)).filter((name) => name.startsWith(`.${PLUGIN_ID}-install-`))).toEqual([]);
}

describe("test-vault installer", () => {
  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "alarm-timer-installer-"));
    await createSource();
  });

  afterEach(async () => {
    await rm(temporaryRoot, { force: true, recursive: true });
  });

  it("copies exactly the release assets into a vault path with spaces and preserves unrelated files", async () => {
    const vault = await createVault();
    const { destination } = await seedExistingDestination(vault);
    const output = [];

    const result = await installTestVault({ vaultPath: vault, sourceRoot, log: (message) => output.push(message) });

    expect(result.destination).toBe(destination);
    expect((await readdir(destination)).sort()).toEqual(["keep.txt", "main.js", "manifest.json", "styles.css"].sort());
    for (const asset of RELEASE_ASSETS) {
      expect(await readFile(join(destination, asset), "utf8")).toBe(await readFile(join(sourceRoot, asset), "utf8"));
    }
    expect(await readFile(join(destination, "keep.txt"), "utf8")).toBe("sentinel");
    expect(output).toEqual(RELEASE_ASSETS.map((asset) => `Installed ${join(destination, asset)}`));
  });

  it.each(FORWARD_RENAME_CALLS)("restores the complete old asset set when rename %i fails", async (failureCall) => {
    const vault = await createVault();
    const existing = await seedExistingDestination(vault);
    const output = [];
    let renameCall = 0;
    const renameFile = async (from, to) => {
      renameCall += 1;
      if (renameCall === failureCall) throw new Error(`injected rename ${failureCall}`);
      await rename(from, to);
    };

    await expect(installTestVault({ vaultPath: vault, sourceRoot, log: (message) => output.push(message), renameFile }))
      .rejects.toThrow(`injected rename ${failureCall}`);

    await expectOldDestination(existing);
    expect(output).toEqual([]);
  });

  it("reports the original installation error together with rollback errors", async () => {
    const vault = await createVault();
    const { destination } = await seedExistingDestination(vault);
    let renameCall = 0;
    const installFailureCall = RELEASE_ASSETS.length + 1;
    const restoreFailureCall = installFailureCall + 1;
    const renameFile = async (from, to) => {
      renameCall += 1;
      if (renameCall === installFailureCall) throw new Error("install rename failed");
      if (renameCall === restoreFailureCall) throw new Error("restore rename failed");
      await rename(from, to);
    };

    let caught;
    try {
      await installTestVault({ vaultPath: vault, sourceRoot, log: () => undefined, renameFile });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught.errors.map((error) => error.message)).toEqual(["install rename failed", "restore rename failed"]);
    expect(caught.message).toMatch(/rollback was incomplete/);
    expect(await readFile(join(destination, "keep.txt"), "utf8")).toBe("sentinel");
    expect(await readFile(join(destination, "manifest.json"), "utf8")).toBe("old manifest.json");
    expect(await readFile(join(destination, "styles.css"), "utf8")).toBe("old styles.css");
  });

  it.each(RELEASE_ASSETS)("rejects a destination %s symlink without changing its external target or sibling assets", async (asset) => {
    const vault = await createVault();
    const destination = join(await realpath(vault), ".obsidian", "plugins", PLUGIN_ID);
    await mkdir(destination, { recursive: true });
    const siblingContents = new Map();
    for (const sibling of RELEASE_ASSETS) {
      if (sibling === asset) continue;
      const content = `existing ${sibling}\n`;
      siblingContents.set(sibling, content);
      await writeFile(join(destination, sibling), content);
    }
    const externalTarget = join(temporaryRoot, `external-${asset}`);
    const externalContents = Uint8Array.from([0, 1, 2, 3, 255]);
    await writeFile(externalTarget, externalContents);
    await symlink(externalTarget, join(destination, asset), "file");

    await expect(installTestVault({ vaultPath: vault, sourceRoot, log: () => undefined })).rejects.toThrow(/regular file/);

    expect([...await readFile(externalTarget)]).toEqual([...externalContents]);
    expect((await lstat(join(destination, asset))).isSymbolicLink()).toBe(true);
    for (const [sibling, content] of siblingContents) {
      expect(await readFile(join(destination, sibling), "utf8")).toBe(content);
    }
    expect((await readdir(destination)).sort()).toEqual([...RELEASE_ASSETS].sort());
  });

  it("rejects a non-regular destination asset before changing sibling assets", async () => {
    const vault = await createVault();
    const destination = join(await realpath(vault), ".obsidian", "plugins", PLUGIN_ID);
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "main.js"), "old main");
    await mkdir(join(destination, "manifest.json"));
    await writeFile(join(destination, "styles.css"), "old styles");

    await expect(installTestVault({ vaultPath: vault, sourceRoot, log: () => undefined })).rejects.toThrow(/regular file/);

    expect(await readFile(join(destination, "main.js"), "utf8")).toBe("old main");
    expect((await lstat(join(destination, "manifest.json"))).isDirectory()).toBe(true);
    expect(await readFile(join(destination, "styles.css"), "utf8")).toBe("old styles");
    expect((await readdir(destination)).sort()).toEqual([...RELEASE_ASSETS].sort());
  });

  it("requires an existing .obsidian directory", async () => {
    const vault = join(temporaryRoot, "No Obsidian Directory");
    await mkdir(vault);

    await expect(installTestVault({ vaultPath: vault, sourceRoot, log: () => undefined })).rejects.toThrow(/\.obsidian/);
    await expect(lstat(join(vault, ".obsidian"))).rejects.toThrow();
  });

  it("rejects a missing sentinel before reading source assets or creating the destination", async () => {
    const vault = await createVault("Missing Sentinel Vault", false);

    await expect(installTestVault({
      vaultPath: vault,
      sourceRoot: join(temporaryRoot, "missing release source"),
      log: () => undefined
    })).rejects.toThrow(/sentinel/);

    expect(await readdir(join(vault, ".obsidian"))).toEqual([]);
  });

  it("rejects wrong sentinel content before replacing existing or unrelated files", async () => {
    const vault = await createVault();
    const existing = await seedExistingDestination(vault);
    await writeFile(join(vault, DISPOSABLE_SENTINEL), `${PLUGIN_ID}-wrong\n`);

    await expect(installTestVault({ vaultPath: vault, sourceRoot, log: () => undefined }))
      .rejects.toThrow(/must contain exactly/);

    await expectOldDestination(existing);
  });

  it("rejects a symlinked sentinel without changing its target or creating the destination", async () => {
    const vault = await createVault("Symlink Sentinel Vault", false);
    const externalTarget = join(temporaryRoot, "external sentinel");
    await writeFile(externalTarget, `${PLUGIN_ID}\n`);
    await symlink(externalTarget, join(vault, DISPOSABLE_SENTINEL), "file");

    await expect(installTestVault({ vaultPath: vault, sourceRoot, log: () => undefined }))
      .rejects.toThrow(/regular file/);

    expect(await readFile(externalTarget, "utf8")).toBe(`${PLUGIN_ID}\n`);
    expect((await lstat(join(vault, DISPOSABLE_SENTINEL))).isSymbolicLink()).toBe(true);
    expect(await readdir(join(vault, ".obsidian"))).toEqual([]);
  });

  it("rejects a non-regular sentinel before creating the destination", async () => {
    const vault = await createVault("Directory Sentinel Vault", false);
    await mkdir(join(vault, DISPOSABLE_SENTINEL));

    await expect(installTestVault({ vaultPath: vault, sourceRoot, log: () => undefined }))
      .rejects.toThrow(/regular file/);

    expect((await lstat(join(vault, DISPOSABLE_SENTINEL))).isDirectory()).toBe(true);
    expect(await readdir(join(vault, ".obsidian"))).toEqual([]);
  });

  it("rejects a wrong manifest id before creating the destination", async () => {
    await createSource("another-plugin");
    const vault = await createVault();

    await expect(installTestVault({ vaultPath: vault, sourceRoot, log: () => undefined })).rejects.toThrow(/manifest\.json id/);
    expect(await readdir(join(vault, ".obsidian"))).toEqual([]);
  });

  it("rejects a symlinked plugins directory without writing through it", async () => {
    const vault = await createVault();
    const outside = join(temporaryRoot, "outside destination");
    await mkdir(outside);
    await symlink(outside, join(vault, ".obsidian", "plugins"), "junction");

    await expect(installTestVault({ vaultPath: vault, sourceRoot, log: () => undefined })).rejects.toThrow(/real directory/);
    expect(await readdir(outside)).toEqual([]);
  });

  it("resolves one CLI or environment path and rejects conflicts or missing values", () => {
    const relative = join("folder with spaces", "Test Vault");
    expect(parseVaultTarget(["--vault", relative], {}, temporaryRoot)).toBe(resolve(temporaryRoot, relative));
    expect(parseVaultTarget([], { OBSIDIAN_TEST_VAULT: relative }, temporaryRoot)).toBe(resolve(temporaryRoot, relative));
    expect(() => parseVaultTarget(["--vault", relative], { OBSIDIAN_TEST_VAULT: relative }, temporaryRoot)).toThrow(/either/);
    expect(() => parseVaultTarget([], {}, temporaryRoot)).toThrow(/required/);
    expect(() => parseVaultTarget(["--vault", relative, "--vault", relative], {}, temporaryRoot)).toThrow(/only once/);
  });

  it("rejects root, home, and Obsidian-internal targets", () => {
    const filesystemRoot = parse(resolve(temporaryRoot)).root;
    expect(() => parseVaultTarget(["--vault", filesystemRoot], {}, temporaryRoot)).toThrow(/filesystem root/);
    expect(() => parseVaultTarget(["--vault", homedir()], {}, temporaryRoot)).toThrow(/home directory/);
    expect(() => parseVaultTarget(["--vault", join(temporaryRoot, ".obsidian")], {}, temporaryRoot)).toThrow(/vault root/);
    expect(() => parseVaultTarget(["--vault", join(temporaryRoot, ".obsidian", "plugins", PLUGIN_ID)], {}, temporaryRoot)).toThrow(/vault root/);
  });
});
