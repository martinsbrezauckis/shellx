#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST_SCHEMA = "shellx/public-export-manifest@4";
const MANIFEST_PATH = "PUBLIC_EXPORT_MANIFEST.json";
const HUMAN_MANIFEST_PATH = "PUBLIC_EXPORT_MANIFEST.txt";

function readArg(args, name) {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const prefix = `${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function fail(message) {
  throw new Error(`release build input verification failed: ${message}`);
}

function git(repo, args, options = {}) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    ...options,
  }).trim();
}

function requireCleanGitCheckout(repo, label, verifyIgnoredBuildPaths = false) {
  const inside = git(repo, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") fail(`${label} is not a Git worktree`);
  const status = git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status) fail(`${label} has tracked or staged changes`);
  if (!verifyIgnoredBuildPaths) return;
  const allowedIgnoredRoots = new Set([
    "dist/",
    "node_modules/",
    "src-tauri/gen/",
    "src-tauri/target/",
    "vendor/shellx-vault/web/dist/",
  ]);
  const ignored = git(repo, [
    "status", "--ignored=matching", "--porcelain=v1", "--untracked-files=all",
  ]).split("\n").filter((row) => row.startsWith("!! ")).map((row) => row.slice(3));
  for (const path of ignored) {
    if (!allowedIgnoredRoots.has(path)) fail(`ignored build input is not allowed: ${path}`);
    const absolute = join(repo, path);
    const stat = lstatSync(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail(`allowed generated build root is not a regular directory: ${path}`);
    }
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeRelativePath(value) {
  return typeof value === "string"
    && value.length > 0
    && !value.startsWith("/")
    && !value.startsWith("\\")
    && !value.includes("\\")
    && !/^[A-Za-z]:/.test(value)
    && value.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

function walkRegularFiles(root) {
  const rows = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" && directory === root) continue;
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) fail(`symlink is not allowed in verified build input: ${absolute}`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) rows.push(relative(root, absolute).split(sep).join("/"));
      else fail(`non-regular build input is not allowed: ${absolute}`);
    }
  };
  visit(root);
  return rows.sort();
}

function trackedFiles(repo) {
  const output = execFileSync("git", ["-C", repo, "ls-files", "-z"], {
    maxBuffer: 128 * 1024 * 1024,
  }).toString("utf8");
  return output.split("\0").filter(Boolean).sort();
}

function modeFor(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`verified path is not a regular file: ${path}`);
  return (stat.mode & 0o111) !== 0 ? "100755" : "100644";
}

function assertExactFileTree(expectedRoot, buildRoot) {
  const expected = walkRegularFiles(expectedRoot);
  const actualTracked = trackedFiles(buildRoot);
  if (JSON.stringify(actualTracked) !== JSON.stringify(expected)) {
    fail("build checkout tracked paths differ from the regenerated exact source export");
  }
  for (const path of expected) {
    const expectedAbsolute = join(expectedRoot, path);
    const actualAbsolute = join(buildRoot, path);
    if (modeFor(actualAbsolute) !== modeFor(expectedAbsolute)) {
      fail(`build input mode differs from exact source export: ${path}`);
    }
    if (sha256(readFileSync(actualAbsolute)) !== sha256(readFileSync(expectedAbsolute))) {
      fail(`build input bytes differ from exact source export: ${path}`);
    }
  }
}

function validateManifest(buildRoot, expectedCommit, expectedTree) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(buildRoot, MANIFEST_PATH), "utf8"));
  } catch (error) {
    fail(`${MANIFEST_PATH} is missing or invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest?.schema !== MANIFEST_SCHEMA) fail(`${MANIFEST_PATH} schema is not ${MANIFEST_SCHEMA}`);
  if (manifest?.source?.commit !== expectedCommit || manifest?.source?.tree !== expectedTree) {
    fail(`${MANIFEST_PATH} does not bind the expected source commit and tree`);
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    fail(`${MANIFEST_PATH} has no payload entries`);
  }
  const paths = new Set();
  let totalBytes = 0;
  for (const entry of manifest.entries) {
    if (!safeRelativePath(entry?.path) || paths.has(entry.path)) {
      fail(`${MANIFEST_PATH} has an unsafe or duplicate payload path`);
    }
    paths.add(entry.path);
    const absolute = resolve(buildRoot, entry.path);
    const bytes = readFileSync(absolute);
    if (entry.mode !== modeFor(absolute)
      || entry.bytes !== bytes.length
      || entry.sha256 !== sha256(bytes)) {
      fail(`${MANIFEST_PATH} payload identity mismatch: ${entry.path}`);
    }
    totalBytes += bytes.length;
  }
  if (manifest.payload?.fileCount !== manifest.entries.length
    || manifest.payload?.totalBytes !== totalBytes
    || manifest.payload?.digest !== sha256(Buffer.from(JSON.stringify(manifest.entries), "utf8"))) {
    fail(`${MANIFEST_PATH} payload summary is invalid`);
  }
  const expectedTracked = [...paths, MANIFEST_PATH].sort();
  if (JSON.stringify(trackedFiles(buildRoot)) !== JSON.stringify(expectedTracked)) {
    fail("public export Git index does not exactly match the machine manifest");
  }
  const human = readFileSync(join(buildRoot, HUMAN_MANIFEST_PATH), "utf8");
  const commitRows = human.match(/^Source commit: ([0-9a-f]{40,64})$/gm) ?? [];
  const treeRows = human.match(/^Source tree: ([0-9a-f]{40,64})$/gm) ?? [];
  if (commitRows.length !== 1 || commitRows[0] !== `Source commit: ${expectedCommit}`
    || treeRows.length !== 1 || treeRows[0] !== `Source tree: ${expectedTree}`) {
    fail(`${HUMAN_MANIFEST_PATH} does not match the machine source identity`);
  }
  return manifest;
}

function regenerateExpectedExport(sourceRepo, expectedCommit) {
  const temp = mkdtempSync(join(tmpdir(), "shellx-release-build-input-"));
  const archivePath = join(temp, "source.tar");
  const payloadRoot = join(temp, "payload");
  mkdirSync(payloadRoot);
  execFileSync("git", [
    "-c", "core.autocrlf=false", "-C", sourceRepo, "archive", "--format=tar",
    `--output=${archivePath}`, expectedCommit,
  ]);
  execFileSync("tar", ["-C", payloadRoot, "-xf", archivePath]);
  execFileSync(process.execPath, [
    join(payloadRoot, "scripts", "prepare-public-export.mjs"),
    "--repo-root", sourceRepo,
    "--payload-root", payloadRoot,
    "--source-commit", expectedCommit,
  ], { stdio: ["ignore", "ignore", "inherit"] });
  return { temp, payloadRoot };
}

export function verifyReleaseBuildInput({
  buildRoot: buildRootInput,
  sourceRepo: sourceRepoInput,
  expectedCommit,
  allowManifestOnly = false,
}) {
  if (!buildRootInput) fail("--build-root is required");
  const buildRoot = realpathSync(resolve(buildRootInput));
  requireCleanGitCheckout(buildRoot, "build checkout", true);

  let sourceRepo = null;
  let sourceTree = null;
  if (sourceRepoInput) {
    sourceRepo = realpathSync(resolve(sourceRepoInput));
    requireCleanGitCheckout(sourceRepo, "canonical source checkout");
    const verifierRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
    if (verifierRoot !== sourceRepo) fail("verifier must execute from the canonical source checkout");
    const head = git(sourceRepo, ["rev-parse", "HEAD"]);
    if (!/^[0-9a-f]{40,64}$/.test(expectedCommit ?? "") || head !== expectedCommit) {
      fail("canonical source HEAD does not equal the expected source commit");
    }
    sourceTree = git(sourceRepo, ["rev-parse", `${expectedCommit}^{tree}`]);
  } else if (!allowManifestOnly) {
    fail("--source-repo is required for a release-bound verification");
  }

  const hasManifest = trackedFiles(buildRoot).includes(MANIFEST_PATH);
  if (!hasManifest) {
    if (!sourceRepo || sourceRepo !== buildRoot) {
      fail("a build without a public-export manifest must be the canonical source checkout");
    }
    return {
      schema: "shellx/release-build-input@1",
      mode: "canonical-source",
      sourceCommit: expectedCommit,
      sourceTree,
      payloadDigest: git(sourceRepo, ["rev-parse", `${expectedCommit}^{tree}`]),
    };
  }

  if (!sourceRepo) {
    const manifest = JSON.parse(readFileSync(join(buildRoot, MANIFEST_PATH), "utf8"));
    const commit = manifest?.source?.commit;
    const tree = manifest?.source?.tree;
    if (!/^[0-9a-f]{40,64}$/.test(commit ?? "") || !/^[0-9a-f]{40,64}$/.test(tree ?? "")) {
      fail(`${MANIFEST_PATH} has no exact source identity`);
    }
    const validated = validateManifest(buildRoot, commit, tree);
    return {
      schema: "shellx/release-build-input@1",
      mode: "manifest-only-development",
      sourceCommit: commit,
      sourceTree: tree,
      payloadDigest: validated.payload.digest,
    };
  }

  const generated = regenerateExpectedExport(sourceRepo, expectedCommit);
  try {
    assertExactFileTree(generated.payloadRoot, buildRoot);
    const manifest = validateManifest(buildRoot, expectedCommit, sourceTree);
    return {
      schema: "shellx/release-build-input@1",
      mode: "canonical-public-export",
      sourceCommit: expectedCommit,
      sourceTree,
      payloadDigest: manifest.payload.digest,
    };
  } finally {
    rmSync(generated.temp, { recursive: true, force: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  const result = verifyReleaseBuildInput({
    buildRoot: readArg(args, "--build-root"),
    sourceRepo: readArg(args, "--source-repo"),
    expectedCommit: readArg(args, "--expected-commit"),
    allowManifestOnly: args.includes("--allow-manifest-only-development"),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
