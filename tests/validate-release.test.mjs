import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXPECTED_PLUGIN_ID,
  EXPECTED_PLUGIN_NAME,
  RELEASE_ASSETS,
  REQUIRED_PUBLIC_ARTIFACTS,
  validateReleaseMetadata
} from "../scripts/validate-release.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const temporaryRoots = [];
const CURRENT_VERSION = "1.0.1";

async function validMetadata() {
  return {
    packageJson: JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")),
    manifest: JSON.parse(await readFile(join(projectRoot, "manifest.json"), "utf8")),
    versions: JSON.parse(await readFile(join(projectRoot, "versions.json"), "utf8"))
  };
}

async function createProject(change = () => undefined) {
  const root = await mkdtemp(join(tmpdir(), "alarm-timer-release-"));
  temporaryRoots.push(root);
  const metadata = await validMetadata();
  change(metadata);
  await mkdir(join(root, "screenshots"), { recursive: true });
  await Promise.all([
    writeFile(join(root, "package.json"), JSON.stringify(metadata.packageJson)),
    writeFile(join(root, "manifest.json"), JSON.stringify(metadata.manifest)),
    writeFile(join(root, "versions.json"), JSON.stringify(metadata.versions)),
    ...REQUIRED_PUBLIC_ARTIFACTS.map((filename) => copyFile(join(projectRoot, filename), join(root, filename)))
  ]);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("release metadata validator", () => {
  it("accepts the current release identity and exact asset allowlist", async () => {
    await expect(validateReleaseMetadata({ projectRoot, tagName: CURRENT_VERSION })).resolves.toEqual({
      id: "alarm-timer",
      version: CURRENT_VERSION,
      assets: RELEASE_ASSETS
    });
  });

  it("keeps the plugin identity stable while using a contextual README heading", async () => {
    const { packageJson, manifest } = await validMetadata();
    const readme = await readFile(join(projectRoot, "README.md"), "utf8");
    expect({
      validatorDisplayName: EXPECTED_PLUGIN_NAME,
      manifestDisplayName: manifest.name,
      validatorTechnicalId: EXPECTED_PLUGIN_ID,
      manifestTechnicalId: manifest.id,
      packageName: packageJson.name
    }).toEqual({
      validatorDisplayName: "Alarm and Timer",
      manifestDisplayName: "Alarm and Timer",
      validatorTechnicalId: "alarm-timer",
      manifestTechnicalId: "alarm-timer",
      packageName: "alarm-timer"
    });
    expect(readme.split(/\r?\n/u)[0]).toBe("# Alarm and Timer for Obsidian");
  });

  it("reports invalid JSON without echoing file content", async () => {
    const root = await createProject();
    await writeFile(join(root, "manifest.json"), "{secret-token");
    await expect(validateReleaseMetadata({ projectRoot: root })).rejects.toThrow("manifest.json must contain valid JSON.");
  });

  it.each(REQUIRED_PUBLIC_ARTIFACTS)("requires public artifact %s", async (filename) => {
    const root = await createProject();
    await rm(join(root, filename));

    await expect(validateReleaseMetadata({ projectRoot: root })).rejects.toThrow(
      `Required public artifact is missing: ${filename}.`
    );
  });

  it.each([
    "screenshots/social-preview.png",
    "screenshots/alarm-view.png",
    "screenshots/timer-view.png",
    "screenshots/timer-alert.png"
  ])("requires README.md to reference %s", async (filename) => {
    const root = await createProject();
    const readmePath = join(root, "README.md");
    const readme = await readFile(readmePath, "utf8");
    await writeFile(readmePath, readme.replace(`](${filename})`, "](removed.png)"));

    await expect(validateReleaseMetadata({ projectRoot: root })).rejects.toThrow(
      `README.md must reference ${filename}.`
    );
  });

  it.each([
    ["requires a private package", ({ packageJson }) => { packageJson.private = false; }, "package.json private must be true"],
    ["requires the package and manifest identity", ({ manifest }) => { manifest.id = "other-plugin"; }, "package.json name and manifest.json id must both be alarm-timer"],
    ["rejects a wrong manifest display name", ({ manifest }) => { manifest.name = "Other Plugin"; }, "manifest.json name must be Alarm and Timer"],
    ["rejects a missing manifest display name", ({ manifest }) => { delete manifest.name; }, "manifest.json name must be Alarm and Timer"],
    ["rejects package author drift", ({ packageJson }) => { packageJson.author = "Other Author"; }, "package.json author and manifest.json author must both be Burak Ozdemir"],
    ["rejects manifest author drift", ({ manifest }) => { manifest.author = "Other Author"; }, "package.json author and manifest.json author must both be Burak Ozdemir"],
    ["rejects package description drift", ({ packageJson }) => { packageJson.description = "Other description."; }, "package.json description and manifest.json description must both match the approved plugin description"],
    ["rejects manifest description drift", ({ manifest }) => { manifest.description = "Other description."; }, "package.json description and manifest.json description must both match the approved plugin description"],
    ["rejects a wrong manifest author URL", ({ manifest }) => { manifest.authorUrl = "https://example.com/"; }, "manifest.json authorUrl must be https://onlinealarmkur.com/en/"],
    ["rejects a missing manifest author URL", ({ manifest }) => { delete manifest.authorUrl; }, "manifest.json authorUrl must be https://onlinealarmkur.com/en/"],
    ["rejects mobile compatibility", ({ manifest }) => { manifest.isDesktopOnly = false; }, "manifest.json isDesktopOnly must be the boolean true"],
    ["rejects a true-like desktop-only string", ({ manifest }) => { manifest.isDesktopOnly = "true"; }, "manifest.json isDesktopOnly must be the boolean true"],
    ["rejects missing desktop-only compatibility", ({ manifest }) => { delete manifest.isDesktopOnly; }, "manifest.json isDesktopOnly must be the boolean true"],
    ["requires matching package and manifest versions", ({ packageJson }) => { packageJson.version = "9.9.9"; }, "package.json and manifest.json versions must match"],
    ["rejects leading-v versions", ({ packageJson, manifest, versions }) => {
      packageJson.version = "v1.0.0";
      manifest.version = "v1.0.0";
      versions["v1.0.0"] = versions["1.0.0"];
    }, "Release versions must not use a leading v"],
    ["rejects two-component plugin versions", ({ packageJson, manifest, versions }) => {
      packageJson.version = "1.0";
      manifest.version = "1.0";
      versions["1.0"] = manifest.minAppVersion;
    }, "Plugin versions must use numeric x.y.z format"],
    ["rejects one-component plugin versions", ({ packageJson, manifest, versions }) => {
      packageJson.version = "1";
      manifest.version = "1";
      versions["1"] = manifest.minAppVersion;
    }, "Plugin versions must use numeric x.y.z format"],
    ["rejects suffixed plugin versions", ({ packageJson, manifest, versions }) => {
      packageJson.version = "1.0.0-beta.1";
      manifest.version = "1.0.0-beta.1";
      versions["1.0.0-beta.1"] = manifest.minAppVersion;
    }, "Plugin versions must use numeric x.y.z format"],
    ["rejects malformed manifest minimum-app versions", ({ manifest, versions }) => {
      manifest.minAppVersion = "1.7";
      versions[manifest.version] = manifest.minAppVersion;
    }, "manifest.json minAppVersion must use numeric x.y.z format"],
    ["rejects malformed versions.json plugin-version keys", ({ versions }) => {
      versions["2.0"] = "1.7.2";
    }, "versions.json plugin-version keys must use numeric x.y.z format"],
    ["rejects malformed versions.json minimum-app values", ({ versions }) => {
      versions["2.0.0"] = "1.7";
    }, "versions.json minimum-app values must use numeric x.y.z format"],
    ["requires a versions.json entry", ({ manifest, versions }) => { delete versions[manifest.version]; }, `versions.json must contain an entry for ${CURRENT_VERSION}`],
    ["requires matching minimum app versions", ({ manifest, versions }) => { versions[manifest.version] = "1.8.0"; }, `versions.json minimum app version for ${CURRENT_VERSION} must match manifest.json minAppVersion`],
    ["requires the exact release asset allowlist", ({ packageJson }) => { packageJson.releaseAssets.push("data.json"); }, "Release assets must be exactly: main.js, manifest.json, styles.css"],
    ["requires main.js as the package entry", ({ packageJson }) => { packageJson.main = "dist/main.js"; }, "package.json main must be main.js"]
  ])("%s", async (_name, change, message) => {
    const root = await createProject(change);
    await expect(validateReleaseMetadata({ projectRoot: root })).rejects.toThrow(message);
  });

  it("requires the release tag to exactly match the manifest version", async () => {
    const root = await createProject();
    await expect(validateReleaseMetadata({ projectRoot: root, tagName: "v1.0.0" })).rejects.toThrow(
      "The release tag must exactly match manifest.json version without a leading v."
    );
  });

  it.each([
    ["a branch push", "main"],
    ["a pull request", "123/merge"]
  ])("does not treat GITHUB_REF_NAME as a release tag for %s", async (_description, refName) => {
    await expect(validateReleaseMetadata({
      projectRoot,
      environment: { GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: refName }
    })).resolves.toMatchObject({ id: "alarm-timer", version: CURRENT_VERSION });
  });

  it("validates GITHUB_REF_NAME when GitHub identifies the ref as a tag", async () => {
    await expect(validateReleaseMetadata({
      projectRoot,
      environment: { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v1.0.0" }
    })).rejects.toThrow("The release tag must exactly match manifest.json version without a leading v.");
  });

  it("rejects an incomplete GitHub tag environment", async () => {
    await expect(validateReleaseMetadata({
      projectRoot,
      environment: { GITHUB_REF_TYPE: "tag" }
    })).rejects.toThrow("GitHub reported a tag ref without a tag name.");
  });
});
