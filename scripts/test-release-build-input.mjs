import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-release-build-input-test-"));
const source = join(temp, "source");
const build = join(temp, "public-export");
const archive = join(temp, "source.tar");
const fixtureGenerator = String.raw`#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
const repo = arg("--repo-root");
const root = arg("--payload-root");
const commit = arg("--source-commit");
const tree = execFileSync("git", ["-C", repo, "rev-parse", commit + "^{tree}"], { encoding: "utf8" }).trim();
const human = "ShellX public export\nSource commit: " + commit + "\nSource tree: " + tree + "\n";
writeFileSync(join(root, "PUBLIC_EXPORT_MANIFEST.txt"), human);
const paths = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) walk(absolute);
    else paths.push(relative(root, absolute).split(sep).join("/"));
  }
};
walk(root);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const entries = paths.sort().map((path) => {
  const absolute = join(root, path);
  const bytes = readFileSync(absolute);
  return { path, mode: (lstatSync(absolute).mode & 0o111) ? "100755" : "100644", bytes: bytes.length, sha256: sha(bytes) };
});
const manifest = {
  schema: "shellx/public-export-manifest@4",
  source: { commit, tree },
  payload: {
    fileCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    digest: sha(Buffer.from(JSON.stringify(entries), "utf8")),
  },
  entries,
};
writeFileSync(join(root, "PUBLIC_EXPORT_MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");
`;

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function verify(buildRoot, sourceRoot, commit) {
  return spawnSync(process.execPath, [
    join(sourceRoot, "scripts", "verify-release-build-input.mjs"),
    "--build-root", buildRoot,
    "--source-repo", sourceRoot,
    "--expected-commit", commit,
  ], { encoding: "utf8" });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

try {
  mkdirSync(join(source, "scripts"), { recursive: true });
  writeFileSync(
    join(source, "scripts", "verify-release-build-input.mjs"),
    readFileSync(join(root, "scripts", "verify-release-build-input.mjs")),
  );
  writeFileSync(join(source, "scripts", "prepare-public-export.mjs"), fixtureGenerator);
  writeFileSync(join(source, "package.json"), `${JSON.stringify({
    name: "shellx-release-input-fixture",
    description: "Exact source fixture",
    type: "module",
  }, null, 2)}\n`);
  writeFileSync(join(source, "CHANGELOG.md"), "# Fixture\n");
  writeFileSync(join(source, ".gitignore"), ".env\nnode_modules/\ndist/\n");
  run("git", ["init", "-b", "main"], { cwd: source });
  run("git", ["add", "-A"], { cwd: source });
  run("git", [
    "-c", "user.name=ShellX Release Input Test",
    "-c", "user.email=shellx-release-input@example.invalid",
    "commit", "-m", "Synthetic exact source",
  ], { cwd: source });
  const commit = run("git", ["rev-parse", "HEAD"], { cwd: source }).trim();

  mkdirSync(build);
  run("git", ["-c", "core.autocrlf=false", "archive", "--format=tar", `--output=${archive}`, commit], {
    cwd: source,
  });
  run("tar", ["-C", build, "-xf", archive]);
  run(process.execPath, [
    join(build, "scripts", "prepare-public-export.mjs"),
    "--repo-root", source,
    "--payload-root", build,
    "--source-commit", commit,
  ], { cwd: source });
  run("git", ["init", "-b", "main"], { cwd: build });
  run("git", ["add", "-A"], { cwd: build });
  run("git", [
    "-c", "user.name=ShellX Public Export Test",
    "-c", "user.email=shellx-public-export@example.invalid",
    "commit", "-m", "Synthetic public export",
  ], { cwd: build });
  const valid = verify(build, source, commit);
  assert.equal(valid.status, 0, valid.stderr);
  const identity = JSON.parse(valid.stdout);
  assert.equal(identity.mode, "canonical-public-export");
  assert.equal(identity.sourceCommit, commit);

  mkdirSync(join(build, "node_modules", "fixture"), { recursive: true });
  writeFileSync(join(build, "node_modules", "fixture", "index.js"), "export {};\n");
  const allowedGenerated = verify(build, source, commit);
  assert.equal(allowedGenerated.status, 0, allowedGenerated.stderr);
  rmSync(join(build, "node_modules"), { recursive: true, force: true });
  mkdirSync(join(build, "vendor", "shellx-vault", "web", "dist"), { recursive: true });
  writeFileSync(join(build, "vendor", "shellx-vault", "web", "dist", "index.html"), "generated\n");
  const allowedVaultWebDist = verify(build, source, commit);
  assert.equal(allowedVaultWebDist.status, 0, allowedVaultWebDist.stderr);
  rmSync(join(build, "vendor", "shellx-vault", "web", "dist"), { recursive: true, force: true });
  writeFileSync(join(build, ".env"), "FORGED_RELEASE_VALUE=1\n");
  const ignoredInput = verify(build, source, commit);
  assert.notEqual(ignoredInput.status, 0);
  assert.match(ignoredInput.stderr, /ignored build input is not allowed: \.env/);
  rmSync(join(build, ".env"));

  const canonical = verify(source, source, commit);
  assert.equal(canonical.status, 0, canonical.stderr);
  assert.equal(JSON.parse(canonical.stdout).mode, "canonical-source");

  appendFileSync(join(build, "package.json"), "\n");
  const dirtyBuild = verify(build, source, commit);
  assert.notEqual(dirtyBuild.status, 0);
  assert.match(dirtyBuild.stderr, /tracked or staged changes/);
  run("git", ["checkout", "--", "package.json"], { cwd: build });

  const packagePath = join(build, "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  packageJson.description = `${packageJson.description} forged`;
  const packageBytes = Buffer.from(`${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  writeFileSync(packagePath, packageBytes);
  const manifestPath = join(build, "PUBLIC_EXPORT_MANIFEST.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entry = manifest.entries.find((candidate) => candidate.path === "package.json");
  assert(entry, "public export manifest must include package.json");
  entry.bytes = packageBytes.length;
  entry.sha256 = sha256(packageBytes);
  manifest.payload.totalBytes = manifest.entries.reduce((sum, candidate) => sum + candidate.bytes, 0);
  manifest.payload.digest = sha256(Buffer.from(JSON.stringify(manifest.entries), "utf8"));
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  run("git", ["add", "package.json", "PUBLIC_EXPORT_MANIFEST.json"], { cwd: build });
  run("git", [
    "-c", "user.name=ShellX Release Input Test",
    "-c", "user.email=shellx-release-input@example.invalid",
    "commit", "-m", "Forge internally consistent export",
  ], { cwd: build });
  const forgedExport = verify(build, source, commit);
  assert.notEqual(forgedExport.status, 0);
  assert.match(forgedExport.stderr, /differ from .*exact source export/);

  appendFileSync(join(source, "CHANGELOG.md"), "\n");
  const dirtySource = verify(source, source, commit);
  assert.notEqual(dirtySource.status, 0);
  assert.match(dirtySource.stderr, /build checkout has tracked or staged changes/);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log("PASS release build input identity tests");
