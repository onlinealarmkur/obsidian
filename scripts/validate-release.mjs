import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const RELEASE_ASSETS = Object.freeze(["main.js", "manifest.json", "styles.css"]);
export const REQUIRED_PUBLIC_ARTIFACTS = Object.freeze([
  "README.md",
  "LICENSE",
  "screenshots/social-preview.png",
  "screenshots/alarm-view.png",
  "screenshots/timer-view.png",
  "screenshots/timer-alert.png"
]);
const README_SCREENSHOTS = Object.freeze([
  "screenshots/social-preview.png",
  "screenshots/alarm-view.png",
  "screenshots/timer-view.png",
  "screenshots/timer-alert.png"
]);
export const EXPECTED_PLUGIN_ID = "alarm-timer";
export const EXPECTED_PLUGIN_NAME = "Alarm and Timer";
const EXPECTED_PLUGIN_AUTHOR = "Burak Ozdemir";
const EXPECTED_PLUGIN_DESCRIPTION = "Set one-time alarms for specific times and run multiple countdown timers from the sidebar.";
const EXPECTED_PLUGIN_AUTHOR_URL = "https://onlinealarmkur.com/en/";
const EXPECTED_IS_DESKTOP_ONLY = true;
const NUMERIC_VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;

function fail(message) {
  throw new Error(message);
}

function requireNumericVersion(value, message) {
  if (typeof value !== "string" || !NUMERIC_VERSION_PATTERN.test(value)) fail(message);
}

async function readJson(projectRoot, filename) {
  try {
    return JSON.parse(await readFile(resolve(projectRoot, filename), "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) fail(`${filename} must contain valid JSON.`);
    throw error;
  }
}

function validateAssetAllowlist(releaseAssets) {
  if (!Array.isArray(releaseAssets) || releaseAssets.some((asset) => typeof asset !== "string")) {
    fail("package.json releaseAssets must be an array of filenames.");
  }
  const actual = [...new Set(releaseAssets)].sort();
  const expected = [...RELEASE_ASSETS].sort();
  if (actual.length !== releaseAssets.length || JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`Release assets must be exactly: ${RELEASE_ASSETS.join(", ")}.`);
  }
}

function releaseTagFromEnvironment(environment) {
  if (environment.GITHUB_REF_TYPE !== "tag") return undefined;
  if (typeof environment.GITHUB_REF_NAME !== "string" || environment.GITHUB_REF_NAME.length === 0) {
    fail("GitHub reported a tag ref without a tag name.");
  }
  return environment.GITHUB_REF_NAME;
}

async function validatePublicArtifacts(projectRoot) {
  for (const filename of REQUIRED_PUBLIC_ARTIFACTS) {
    let content;
    try {
      content = await readFile(resolve(projectRoot, filename));
    } catch {
      fail(`Required public artifact is missing: ${filename}.`);
    }
    if (content.length === 0) fail(`Required public artifact must not be empty: ${filename}.`);
  }
  const readme = await readFile(resolve(projectRoot, "README.md"), "utf8");
  for (const screenshot of README_SCREENSHOTS) {
    if (!readme.includes(`](${screenshot})`)) {
      fail(`README.md must reference ${screenshot}.`);
    }
  }
}

export async function validateReleaseMetadata(options = {}) {
  const projectRoot = options.projectRoot ?? resolve(fileURLToPath(new URL("..", import.meta.url)));
  const tagName = options.tagName ?? releaseTagFromEnvironment(options.environment ?? process.env);
  const packageJson = await readJson(projectRoot, "package.json");
  const manifest = await readJson(projectRoot, "manifest.json");
  const versions = await readJson(projectRoot, "versions.json");
  await validatePublicArtifacts(projectRoot);

  if (packageJson.private !== true) fail("package.json private must be true; releases are distributed through GitHub, not npm.");
  if (packageJson.name !== EXPECTED_PLUGIN_ID || manifest.id !== EXPECTED_PLUGIN_ID || packageJson.name !== manifest.id) {
    fail(`package.json name and manifest.json id must both be ${EXPECTED_PLUGIN_ID}.`);
  }
  if (manifest.name !== EXPECTED_PLUGIN_NAME) {
    fail(`manifest.json name must be ${EXPECTED_PLUGIN_NAME}.`);
  }
  if (packageJson.author !== EXPECTED_PLUGIN_AUTHOR || manifest.author !== EXPECTED_PLUGIN_AUTHOR) {
    fail(`package.json author and manifest.json author must both be ${EXPECTED_PLUGIN_AUTHOR}.`);
  }
  if (packageJson.description !== EXPECTED_PLUGIN_DESCRIPTION || manifest.description !== EXPECTED_PLUGIN_DESCRIPTION) {
    fail("package.json description and manifest.json description must both match the approved plugin description.");
  }
  if (manifest.authorUrl !== EXPECTED_PLUGIN_AUTHOR_URL) {
    fail(`manifest.json authorUrl must be ${EXPECTED_PLUGIN_AUTHOR_URL}.`);
  }
  if (manifest.isDesktopOnly !== EXPECTED_IS_DESKTOP_ONLY) {
    fail("manifest.json isDesktopOnly must be the boolean true.");
  }
  if (typeof packageJson.version !== "string" || typeof manifest.version !== "string" || packageJson.version !== manifest.version) {
    fail("package.json and manifest.json versions must match.");
  }
  if (manifest.version.startsWith("v")) fail("Release versions must not use a leading v.");
  requireNumericVersion(manifest.version, "Plugin versions must use numeric x.y.z format.");
  requireNumericVersion(manifest.minAppVersion, "manifest.json minAppVersion must use numeric x.y.z format.");
  for (const [pluginVersion, minimumAppVersion] of Object.entries(versions)) {
    requireNumericVersion(pluginVersion, "versions.json plugin-version keys must use numeric x.y.z format.");
    requireNumericVersion(minimumAppVersion, "versions.json minimum-app values must use numeric x.y.z format.");
  }
  if (!(manifest.version in versions)) fail(`versions.json must contain an entry for ${manifest.version}.`);
  if (versions[manifest.version] !== manifest.minAppVersion) {
    fail(`versions.json minimum app version for ${manifest.version} must match manifest.json minAppVersion.`);
  }
  if (tagName !== undefined && tagName !== manifest.version) {
    fail("The release tag must exactly match manifest.json version without a leading v.");
  }
  if (packageJson.main !== "main.js") fail("package.json main must be main.js.");
  validateAssetAllowlist(packageJson.releaseAssets);

  return { id: manifest.id, version: manifest.version, assets: [...RELEASE_ASSETS] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await validateReleaseMetadata();
    process.stdout.write(`Release metadata valid for ${result.id} ${result.version}.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Release metadata validation failed."}\n`);
    process.exitCode = 1;
  }
}
