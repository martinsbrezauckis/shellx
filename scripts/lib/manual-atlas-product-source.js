import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export const MANUAL_ATLAS_PRODUCT_SOURCE_SCHEMA = "shellx/manual-atlas-product-source@2";

const PRODUCT_EXACT_PATHS = [
  "index.html",
  "package.json",
  "pnpm-lock.yaml",
  "shellx-browser.html",
  "src-tauri/Cargo.lock",
  "src-tauri/Cargo.toml",
  "src-tauri/build.rs",
  "src-tauri/tauri.conf.json",
  "vite.config.ts",
];

const PRODUCT_PATH_PREFIXES = [
  "src/",
  "src-tauri/capabilities/",
  "src-tauri/icons/",
  "src-tauri/src/",
];

export function calculateManualAtlasProductSourceSha256(repoRoot) {
  const root = resolve(repoRoot);
  const entries = [];
  for (const path of PRODUCT_EXACT_PATHS) {
    entries.push({ path, bytes: readRegularFile(root, path) });
  }
  for (const prefix of PRODUCT_PATH_PREFIXES) {
    const directory = resolve(root, prefix.slice(0, -1));
    collectRegularFiles(root, directory, entries);
  }
  return hashProductEntries(entries);
}

export function calculateManualAtlasProductSourceSha256FromGit(repoRoot, sourceCommit) {
  if (!/^[a-f0-9]{40,64}$/.test(sourceCommit)) {
    throw new Error("manual atlas source commit must be an exact Git object id");
  }
  const root = resolve(repoRoot);
  const paths = execFileSync(
    "git",
    ["-C", root, "ls-tree", "-rz", "--name-only", sourceCommit, "--", ...PRODUCT_EXACT_PATHS, ...PRODUCT_PATH_PREFIXES],
    { maxBuffer: 64 * 1024 * 1024 },
  ).toString("utf8").split("\0").filter(isProductSourcePath).sort();
  const pathSet = new Set(paths);
  const missing = PRODUCT_EXACT_PATHS.filter((path) => !pathSet.has(path));
  if (missing.length > 0) {
    throw new Error(`manual atlas source commit is missing product paths: ${missing.join(", ")}`);
  }
  return hashProductEntries(paths.map((path) => ({
    path,
    bytes: execFileSync("git", ["-C", root, "show", `${sourceCommit}:${path}`], {
      maxBuffer: 128 * 1024 * 1024,
    }),
  })));
}

export function isProductSourcePath(path) {
  const included = PRODUCT_EXACT_PATHS.includes(path)
    || PRODUCT_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
  if (!included) return false;
  const segments = path.split("/");
  return !segments.some((segment) => (
    segment === "__tests__"
    || segment === "test"
    || segment === "tests"
    || segment.endsWith("_tests")
  ))
    && !/(?:_test|_tests)\.rs$/u.test(path)
    && !/\.(?:test|spec)\.[^/]+$/u.test(path);
}

function collectRegularFiles(root, directory, entries) {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`manual atlas product source directory is unsafe: ${relative(root, directory)}`);
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`manual atlas product source cannot contain symlinks: ${relative(root, absolute)}`);
    }
    if (entry.isDirectory()) collectRegularFiles(root, absolute, entries);
    else if (entry.isFile()) {
      const path = relative(root, absolute).split(sep).join("/");
      entries.push({ path, bytes: readFileSync(absolute) });
    }
  }
}

function readRegularFile(root, path) {
  const absolute = resolve(root, path);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`manual atlas product source file is unsafe: ${path}`);
  }
  return readFileSync(absolute);
}

function hashProductEntries(entries) {
  const unique = new Map();
  for (const entry of entries) {
    if (!isProductSourcePath(entry.path)) continue;
    if (unique.has(entry.path)) throw new Error(`manual atlas product source repeats ${entry.path}`);
    unique.set(entry.path, entry.bytes);
  }
  const hash = createHash("sha256");
  hash.update(`${MANUAL_ATLAS_PRODUCT_SOURCE_SCHEMA}\0`, "utf8");
  for (const path of [...unique.keys()].sort()) {
    const bytes = unique.get(path);
    hash.update(`${Buffer.byteLength(path, "utf8")}:${path}:${bytes.length}:`, "utf8");
    hash.update(bytes);
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}
