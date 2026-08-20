import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "..");

async function workflow(name) {
  return readFile(resolve(projectRoot, ".github", "workflows", name), "utf8");
}

function releaseJobs(source) {
  const publishStart = source.indexOf("  publish:");
  if (publishStart < 0) throw new Error("Release workflow must contain a publish job.");
  return { build: source.slice(0, publishStart), publish: source.slice(publishStart) };
}

function namedStep(source, name) {
  const start = source.indexOf(`      - name: ${name}\n`);
  if (start < 0) throw new Error(`Release workflow must contain the "${name}" step.`);
  const next = source.indexOf("      - name: ", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

function runBlock(source, name) {
  const step = namedStep(source, name);
  const marker = "        run: |\n";
  const start = step.indexOf(marker);
  if (start < 0) throw new Error(`The "${name}" step must contain a literal run block.`);
  return step
    .slice(start + marker.length)
    .split("\n")
    .map((line) => line.startsWith("          ") ? line.slice(10) : line)
    .join("\n");
}

function expectOrdered(source, markers) {
  let previous = -1;
  for (const marker of markers) {
    const current = source.indexOf(marker);
    expect(current, `Missing ordered marker: ${marker}`).toBeGreaterThan(previous);
    previous = current;
  }
}

describe("GitHub Actions release hardening", () => {
  it("pins every third-party action to a full reviewed commit with a version comment", async () => {
    const sources = await Promise.all([workflow("audit.yml"), workflow("ci.yml"), workflow("release.yml")]);
    const uses = sources.flatMap((source) => source.match(/^\s*uses:.*$/gmu) ?? []);

    expect(uses).toHaveLength(8);
    for (const line of uses) {
      expect(line).toMatch(/^\s*uses: actions\/[a-z-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/u);
    }
  });

  it("builds with read-only contents and without persisted checkout credentials", async () => {
    const { build } = releaseJobs(await workflow("release.yml"));

    expect(build).toContain("permissions:\n      contents: read");
    expect(build).not.toContain("contents: write");
    expect(build).toContain("persist-credentials: false");
    expect(build).toContain("run: npm ci --legacy-peer-deps");
    expect(build).toContain("run: npm run audit:dependencies");
    expect(build).toContain("run: npm run check");
    expect(build).toContain("name: release-assets");
    expect(build).toContain("path: |\n            main.js\n            manifest.json\n            styles.css");
  });

  it("proves the tagged commit belongs to the repository default branch before building", async () => {
    const { build } = releaseJobs(await workflow("release.yml"));
    const checkout = namedStep(build, "Check out repository");
    const provenance = namedStep(build, "Verify release tag belongs to the default branch");

    expect(checkout).toContain("fetch-depth: 0");
    expect(provenance).toContain("DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}");
    expect(provenance).not.toContain("git fetch");
    expect(provenance).toMatch(/^\s+if ! git show-ref --verify --quiet "\$default_ref"; then$/mu);
    expect(provenance).toMatch(
      /^\s+if ! git rev-parse --verify --quiet "\$\{GITHUB_SHA\}\^\{commit\}" >\/dev\/null; then$/mu,
    );
    expect(provenance).toMatch(
      /^\s+if ! git merge-base --is-ancestor "\$GITHUB_SHA" "\$default_ref"; then$/mu,
    );
    expect(provenance.match(/^\s+exit 1$/gmu)).toHaveLength(4);
    expect(provenance).not.toContain("origin/main");

    const provenanceStart = build.indexOf("      - name: Verify release tag belongs to the default branch");
    for (const laterStep of [
      "      - name: Set up Node.js",
      "      - name: Install dependencies",
      "      - name: Validate metadata, run checks, and build release assets",
      "      - name: Upload release assets",
    ]) {
      expect(provenanceStart).toBeLessThan(build.indexOf(laterStep));
    }
  });

  it("audits dependencies immediately after installation in every network-enabled job", async () => {
    const [audit, ci, release] = await Promise.all([workflow("audit.yml"), workflow("ci.yml"), workflow("release.yml")]);

    for (const source of [audit, ci, release]) {
      expect(source.indexOf("run: npm ci --legacy-peer-deps")).toBeLessThan(source.indexOf("run: npm run audit:dependencies"));
    }
    for (const source of [ci, release]) {
      expect(source.indexOf("run: npm run audit:dependencies")).toBeLessThan(source.indexOf("run: npm run check"));
    }
  });

  it("publishes only the downloaded three-file artifact without checkout or npm", async () => {
    const { publish } = releaseJobs(await workflow("release.yml"));

    expect(publish).toContain("needs: build");
    expect(publish).toContain("permissions:\n      contents: write");
    expect(publish).toContain("actions/download-artifact@");
    expect(publish).toContain("name: release-assets");
    expect(publish).toContain("printf '%s\\n' main.js manifest.json styles.css");
    expect(publish).toContain("test ! -L \"release-assets/$asset\"");
    expect(publish).not.toContain("actions/checkout@");
    expect(publish).not.toContain("actions/setup-node@");
    expect(publish).not.toMatch(/\bnpm\b/u);
    expect(publish).toContain("readonly expected_assets_json='[\"main.js\",\"manifest.json\",\"styles.css\"]'");
    expect(publish).toContain("for asset in main.js manifest.json styles.css; do");
    expect(publish).toContain('"release-assets/$asset"');
  });

  it("serializes publication for an exact repository tag", async () => {
    const source = await workflow("release.yml");

    expect(source).toContain(
      "concurrency:\n  group: release-${{ github.repository }}-${{ github.ref }}\n  cancel-in-progress: false",
    );
  });

  it("distinguishes an absent release from an existing draft or published release", async () => {
    const { publish } = releaseJobs(await workflow("release.yml"));
    const release = namedStep(publish, "Publish complete immutable GitHub release");
    const queryRelease = release.slice(
      release.indexOf("          query_release() {"),
      release.indexOf("          require_release_id() {"),
    );

    expect(release).toContain("repository(owner: $owner, name: $name)");
    expect(release).toContain("release(tagName: $tagName)");
    expect(release).toContain("databaseId");
    expect(release).toContain("isDraft");
    expect(queryRelease).toContain("gh api graphql");
    expect(queryRelease).toContain('jq -e \'.data.repository != null\' "$release_state_file"');
    expect(queryRelease).not.toContain("||");
    expect(release).toContain(
      "query_release\n          if jq -e '.data.repository.release == null'",
    );
    expect(release).toContain("jq -e '.data.repository.release == null'");
    expect(release).toContain('gh release create "$tag" \\');
    expect(release).toContain("--draft");
    expect(release).toContain("--verify-tag");
    expect(release).toContain("--generate-notes");
    expect(release).toContain("'.data.repository.release.isDraft == true'");
    expect(release).toContain("Refusing to modify an existing published release.");
    expect(release).toContain("Refusing to upload to a published release.");
    expect(release).toContain(
      'target_release_id="$(require_release_id)"\n          readonly target_release_id',
    );
    expect(release).not.toMatch(/gh release view[^\n]*\|\|[^\n]*gh release create/u);
  });

  it("does not shadow read-only Bash variables with function locals", async () => {
    const { publish } = releaseJobs(await workflow("release.yml"));
    const script = runBlock(publish, "Publish complete immutable GitHub release");
    const readOnlyNames = [...script.matchAll(/^\s*readonly\s+([A-Za-z_][A-Za-z0-9_]*)/gmu)]
      .map((match) => match[1]);
    const localNames = [...script.matchAll(/^\s*local\s+([A-Za-z_][A-Za-z0-9_]*)/gmu)]
      .map((match) => match[1]);

    expect(readOnlyNames.filter((name) => localNames.includes(name))).toEqual([]);
  });

  it("resumes only exact same-byte draft assets without glob or overwrite behavior", async () => {
    const { publish } = releaseJobs(await workflow("release.yml"));
    const release = namedStep(publish, "Publish complete immutable GitHub release");

    expect(release).toContain("gh api --paginate --slurp");
    expect(release).toContain('(.id | type == "number")');
    expect(release).toContain("($names | length) == ($names | unique | length)");
    expect(release).toContain("$expected | index($name) != null");
    expect(release).toContain('"repos/${repository}/releases/assets/${asset_id}"');
    expect(release).toContain('cmp --silent -- "release-assets/$asset_name" "$remote_path"');
    expect(release).toContain("Remote draft asset differs from the built asset");
    expect(release).toContain('gh release upload "$tag" \\');
    expect(release).not.toContain("gh release download");
    expect(release).not.toContain("--pattern");
    expect(release).not.toContain("--clobber");
    expect(release).not.toContain("eval ");
  });

  it("verifies exact uploaded names and bytes before publishing the draft", async () => {
    const { publish } = releaseJobs(await workflow("release.yml"));
    const release = namedStep(publish, "Publish complete immutable GitHub release");

    expectOrdered(release, [
      "# Stage 1: Query or create the exact draft release.",
      "# Stage 2: Resume only compatible assets, then upload missing assets.",
      "# Stage 3: Verify the complete remote name set and every remote byte.",
      "# Stage 4: Publish only the verified draft, without recreating assets.",
    ]);
    expect(release).toContain("([ .[][] | .name ] | sort) == ($expected | sort)");
    expect(release).toContain('and all(.[][]; .state == "uploaded")');
    expect(release).toContain("Draft release assets are missing, duplicated, unexpected, or incomplete.");
    expect(release.match(/download_and_compare_asset "\$asset"/gu)).toHaveLength(2);

    const verifyStage = release.indexOf("# Stage 3:");
    const publishStage = release.indexOf("# Stage 4:");
    const publishCommand = release.indexOf('gh release edit "$tag"', publishStage);
    const publishVerification = release.indexOf(".data.repository.release.isDraft == false", publishCommand);
    expect(verifyStage).toBeLessThan(publishStage);
    expect(publishStage).toBeLessThan(publishCommand);
    expect(publishCommand).toBeLessThan(publishVerification);
    expect(release).toContain("trap 'rm -rf -- \"$temporary_directory\"' EXIT");
  });

  it.skipIf(process.platform === "win32")("contains syntactically valid Bash", async () => {
    const { publish } = releaseJobs(await workflow("release.yml"));
    const script = runBlock(publish, "Publish complete immutable GitHub release");
    const result = spawnSync("bash", ["-n"], { encoding: "utf8", input: script });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });
});
