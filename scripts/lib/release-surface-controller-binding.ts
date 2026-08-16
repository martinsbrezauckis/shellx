import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export interface ReleaseSurfaceControllerFileIdentity {
  relativePath: string;
  basename: string;
  sha256: string;
  bytes: number;
}

export interface ReleaseSurfaceControllerBinding {
  sourceCommit: string;
  sourceTreeOid: string;
  node: { basename: string; sha256: string; bytes: number };
  tsxLoader: { basename: string; sha256: string; bytes: number };
  entrypoint: ReleaseSurfaceControllerFileIdentity;
  auxiliaryFiles: ReleaseSurfaceControllerFileIdentity[];
}

export function createReleaseSurfaceControllerBinding(input: {
  rootDir: string;
  sourceCommit: string;
  entrypoint: string;
  auxiliaryFiles?: string[];
  requireClean?: boolean;
}): ReleaseSurfaceControllerBinding {
  const root = resolve(input.rootDir);
  const head = git(root, ["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40,64}$/.test(input.sourceCommit) || head !== input.sourceCommit) {
    throw new Error("release driver controller HEAD does not match the frozen source commit");
  }
  if (git(root, ["rev-parse", "--show-prefix"]) !== "") {
    throw new Error("release driver controller root must be the exact Git worktree root");
  }
  if (input.requireClean && git(root, ["status", "--porcelain=v1", "--untracked-files=all"])) {
    throw new Error("release driver controller worktree must be clean");
  }
  const sourceTreeOid = git(root, ["rev-parse", `${input.sourceCommit}^{tree}`]);
  if (!/^[a-f0-9]{40,64}$/.test(sourceTreeOid)) {
    throw new Error("release driver controller tree identity is invalid");
  }
  const entrypoint = identifyTrackedControllerFile(root, input.sourceCommit, input.entrypoint);
  const auxiliaryFiles = [...new Set(input.auxiliaryFiles ?? [])]
    .map((path) => identifyTrackedControllerFile(root, input.sourceCommit, path))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return {
    sourceCommit: input.sourceCommit,
    sourceTreeOid,
    node: identifyExternalExecutable(process.execPath, "Node executable"),
    tsxLoader: identifyExternalExecutable(releaseSurfaceControllerTsxLoaderPath(), "tsx loader"),
    entrypoint,
    auxiliaryFiles,
  };
}

export function validateReleaseSurfaceControllerBinding(
  binding: ReleaseSurfaceControllerBinding | undefined,
): string[] {
  const errors: string[] = [];
  if (!binding || typeof binding !== "object") return ["controller binding is required"];
  rejectUnknownKeys(binding, [
    "sourceCommit", "sourceTreeOid", "node", "tsxLoader", "entrypoint", "auxiliaryFiles",
  ], "controller binding", errors);
  if (!/^[a-f0-9]{40,64}$/.test(binding.sourceCommit ?? "")) {
    errors.push("controller sourceCommit must be a lowercase Git object id");
  }
  if (!/^[a-f0-9]{40,64}$/.test(binding.sourceTreeOid ?? "")) {
    errors.push("controller sourceTreeOid must be a lowercase Git object id");
  }
  if (binding.node && typeof binding.node === "object") {
    rejectUnknownKeys(binding.node, ["basename", "sha256", "bytes"], "controller Node executable", errors);
  }
  if (binding.tsxLoader && typeof binding.tsxLoader === "object") {
    rejectUnknownKeys(binding.tsxLoader, ["basename", "sha256", "bytes"], "controller tsx loader", errors);
  }
  validateFileIdentity(binding.node, "controller Node executable", errors);
  validateFileIdentity(binding.tsxLoader, "controller tsx loader", errors);
  validateControllerFileIdentity(binding.entrypoint, "controller entrypoint", errors);
  if (!Array.isArray(binding.auxiliaryFiles)) {
    errors.push("controller auxiliaryFiles must be an array");
  } else {
    const paths = new Set<string>();
    for (const file of binding.auxiliaryFiles) {
      validateControllerFileIdentity(file, "controller auxiliary file", errors);
      if (paths.has(file?.relativePath)) errors.push(`controller auxiliary file ${file?.relativePath} is duplicated`);
      paths.add(file?.relativePath);
    }
    const sorted = [...paths].sort();
    if (JSON.stringify([...paths]) !== JSON.stringify(sorted)) {
      errors.push("controller auxiliaryFiles must be sorted by relative path");
    }
  }
  return errors;
}

export function verifyReleaseSurfaceControllerBinding(input: {
  rootDir: string;
  binding: ReleaseSurfaceControllerBinding;
  requireClean?: boolean;
}): string[] {
  const structural = validateReleaseSurfaceControllerBinding(input.binding);
  if (structural.length > 0) return structural;
  try {
    const observed = createReleaseSurfaceControllerBinding({
      rootDir: input.rootDir,
      sourceCommit: input.binding.sourceCommit,
      entrypoint: input.binding.entrypoint.relativePath,
      auxiliaryFiles: input.binding.auxiliaryFiles.map((file) => file.relativePath),
      requireClean: input.requireClean,
    });
    return JSON.stringify(observed) === JSON.stringify(input.binding)
      ? []
      : ["controller executable identities changed after the request was frozen"];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

export function verifyReleaseSurfaceControllerBindingFromGit(input: {
  rootDir: string;
  binding: ReleaseSurfaceControllerBinding;
}): string[] {
  const structural = validateReleaseSurfaceControllerBinding(input.binding);
  if (structural.length > 0) return structural;
  const root = resolve(input.rootDir);
  try {
    if (git(root, ["rev-parse", "--show-prefix"]) !== "") {
      return ["release controller root must be the exact Git worktree root"];
    }
    const tree = git(root, ["rev-parse", `${input.binding.sourceCommit}^{tree}`]);
    if (tree !== input.binding.sourceTreeOid) {
      return ["controller source tree does not match its exact Git commit"];
    }
    const errors: string[] = [];
    for (const file of [input.binding.entrypoint, ...input.binding.auxiliaryFiles]) {
      errors.push(...verifyBoundControllerFileFromGit(root, input.binding.sourceCommit, file));
    }
    return errors;
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

export function resolveBoundReleaseSurfaceControllerFile(input: {
  rootDir: string;
  binding: ReleaseSurfaceControllerBinding;
  relativePath: string;
}): string {
  const expected = [input.binding.entrypoint, ...input.binding.auxiliaryFiles]
    .find((file) => file.relativePath === input.relativePath);
  if (!expected) throw new Error(`controller file ${input.relativePath} is not bound by the exact release request`);
  const actual = identifyControllerFile(resolve(input.rootDir), input.relativePath);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`controller file ${input.relativePath} changed after the release request was frozen`);
  }
  return resolve(input.rootDir, input.relativePath);
}

export function releaseSurfaceControllerTsxLoaderPath(): string {
  return realpathSync(createRequire(import.meta.url).resolve("tsx"));
}

export function releaseSurfaceControllerModuleSpecifier(path: string): string {
  return pathToFileURL(resolve(path)).href;
}

export function releaseSurfaceControllerTsxLoaderSpecifier(): string {
  return releaseSurfaceControllerModuleSpecifier(releaseSurfaceControllerTsxLoaderPath());
}

export function releaseSurfaceControllerNodeArguments(path: string, args: readonly string[] = []): string[] {
  return [
    "--import",
    releaseSurfaceControllerTsxLoaderSpecifier(),
    "--eval",
    "const moduleUrl = process.argv[1]; process.argv[1] = require('node:url').fileURLToPath(moduleUrl); import(moduleUrl)",
    releaseSurfaceControllerModuleSpecifier(path),
    ...args,
  ];
}

function identifyTrackedControllerFile(
  root: string,
  sourceCommit: string,
  path: string,
): ReleaseSurfaceControllerFileIdentity {
  const identity = identifyControllerFile(root, path);
  try {
    execFileSync("git", ["-C", root, "cat-file", "-e", `${sourceCommit}:${identity.relativePath}`], {
      stdio: "ignore",
    });
  } catch {
    throw new Error(`release controller file is not tracked by the frozen source commit: ${identity.relativePath}`);
  }
  return identity;
}

function verifyBoundControllerFileFromGit(
  root: string,
  sourceCommit: string,
  expected: ReleaseSurfaceControllerFileIdentity,
): string[] {
  let treeEntry: string;
  let value: Buffer;
  try {
    treeEntry = execFileSync(
      "git",
      ["-C", root, "ls-tree", "-z", sourceCommit, "--", expected.relativePath],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024 },
    );
    value = execFileSync(
      "git",
      ["-C", root, "show", `${sourceCommit}:${expected.relativePath}`],
      { encoding: null, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 },
    );
  } catch {
    return [`controller Git file is unavailable: ${expected.relativePath}`];
  }
  const match = /^(100644|100755) blob [a-f0-9]{40,64}\t([^\0]+)\0$/.exec(treeEntry);
  if (!match || match[2] !== expected.relativePath) {
    return [`controller Git file is not one exact regular blob: ${expected.relativePath}`];
  }
  const actual = {
    relativePath: expected.relativePath,
    basename: basename(expected.relativePath),
    sha256: sha256(value),
    bytes: value.length,
  };
  return JSON.stringify(actual) === JSON.stringify(expected)
    ? []
    : [`controller Git file identity changed: ${expected.relativePath}`];
}

function identifyControllerFile(root: string, path: string): ReleaseSurfaceControllerFileIdentity {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) {
    throw new Error("release controller file must be inside the exact Git worktree");
  }
  const relativePath = rel.split(sep).join("/");
  if (relativePath.includes("\\") || /[\r\n\0]/.test(relativePath)) {
    throw new Error("release controller file path is invalid");
  }
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`release controller file must be a regular non-link file: ${relativePath}`);
  }
  const value = readFileSync(absolute);
  if (value.length === 0) throw new Error(`release controller file must not be empty: ${relativePath}`);
  return {
    relativePath,
    basename: basename(absolute),
    sha256: sha256(value),
    bytes: value.length,
  };
}

function identifyExternalExecutable(path: string, label: string): ReleaseSurfaceControllerBinding["node"] {
  const absolute = realpathSync(path);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular non-link file`);
  const value = readFileSync(absolute);
  if (value.length === 0) throw new Error(`${label} must not be empty`);
  return { basename: basename(absolute), sha256: sha256(value), bytes: value.length };
}

function validateControllerFileIdentity(
  value: ReleaseSurfaceControllerFileIdentity | undefined,
  label: string,
  errors: string[],
): void {
  if (!value || typeof value !== "object") {
    errors.push(`${label} identity is required`);
    return;
  }
  rejectUnknownKeys(value, ["relativePath", "basename", "sha256", "bytes"], label, errors);
  if (!safeRelativePath(value.relativePath)) errors.push(`${label} relativePath is invalid`);
  validateFileIdentity(value, label, errors);
}

function validateFileIdentity(
  value: { basename?: string; sha256?: string; bytes?: number } | undefined,
  label: string,
  errors: string[],
): void {
  if (!value || typeof value !== "object") {
    errors.push(`${label} identity is required`);
    return;
  }
  if (!value.basename?.trim() || /[\\/\r\n\0]/.test(value.basename)) errors.push(`${label} basename is invalid`);
  if (!/^[a-f0-9]{64}$/.test(value.sha256 ?? "")) errors.push(`${label} sha256 must be lowercase hexadecimal`);
  if (!Number.isSafeInteger(value.bytes) || Number(value.bytes) <= 0) errors.push(`${label} bytes must be positive`);
}

function safeRelativePath(value: string | undefined): boolean {
  if (!value || value.trim() !== value || value.startsWith("/") || value.includes("\\") || /[\r\n\0]/.test(value)) return false;
  return !value.split("/").some((part) => !part || part === "." || part === "..");
}

function rejectUnknownKeys(
  value: object,
  allowed: readonly string[],
  label: string,
  errors: string[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) errors.push(`${label} contains undeclared field ${key}`);
  }
}

function git(root: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024,
    }).trim();
  } catch {
    throw new Error("unable to prove the release driver controller Git identity");
  }
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
