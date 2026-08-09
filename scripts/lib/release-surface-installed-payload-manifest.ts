import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import type { Stats } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ReleasePlatform } from "./release-surface-inventory";

export const RELEASE_SURFACE_INSTALLED_PAYLOAD_MANIFEST_SCHEMA =
  "shellx/release-surface-installed-payload-manifest@2";

export type ReleaseSurfaceInstalledPayloadManifestEntry =
  | { path: string; kind: "directory" }
  | { path: string; kind: "file"; sha256: string; bytes: number };

export interface ReleaseSurfaceInstalledPayloadManifest {
  schema: typeof RELEASE_SURFACE_INSTALLED_PAYLOAD_MANIFEST_SCHEMA;
  platform: ReleasePlatform;
  collector: "node-filesystem-v1" | "windows-powershell-payload-v1";
  orchestrator: "native" | "wsl";
  scope: "staged-direct-file" | "installer-target-root";
  rootPath: string;
  collectedAt: string;
  mainExecutableRelativePath: string;
  entries: ReleaseSurfaceInstalledPayloadManifestEntry[];
  entryCount: number;
  totalFileBytes: number;
  manifestSha256: string;
}

const RELEASE_SURFACE_WINDOWS_PAYLOAD_OBSERVATION_SCHEMA =
  "shellx/release-surface-windows-payload-observation@1";

interface ReleaseSurfaceWindowsPayloadObservation {
  schema: typeof RELEASE_SURFACE_WINDOWS_PAYLOAD_OBSERVATION_SCHEMA;
  collector: "windows-powershell-payload-v1";
  orchestrator: "native" | "wsl";
  rootPath: string;
  collectedAt: string;
  entries: ReleaseSurfaceInstalledPayloadManifestEntry[];
}

export function collectReleaseSurfaceInstalledPayloadManifestForPlatform(input: {
  nodeRootPath: string;
  recordedRootPath: string;
  platform: ReleasePlatform;
  scope: ReleaseSurfaceInstalledPayloadManifest["scope"];
  mainExecutableRelativePath: string;
  collectedAt?: string;
}): ReleaseSurfaceInstalledPayloadManifest {
  if (input.platform !== "windows-installed") {
    return collectReleaseSurfaceInstalledPayloadManifest(input);
  }
  if (input.collectedAt) throw new Error("Windows native payload collection owns its observation timestamp");
  return collectReleaseSurfaceWindowsInstalledPayloadManifest({
    recordedRootPath: input.recordedRootPath,
    platform: "windows-installed",
    scope: input.scope,
    mainExecutableRelativePath: input.mainExecutableRelativePath,
  });
}

export function collectReleaseSurfaceInstalledPayloadManifest(input: {
  nodeRootPath: string;
  recordedRootPath: string;
  platform: ReleasePlatform;
  scope: ReleaseSurfaceInstalledPayloadManifest["scope"];
  mainExecutableRelativePath: string;
  collectedAt?: string;
}): ReleaseSurfaceInstalledPayloadManifest {
  if (input.platform === "windows-installed") {
    throw new Error("Windows manifests require collectReleaseSurfaceInstalledPayloadManifestForPlatform");
  }
  const root = resolve(input.nodeRootPath);
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`installed payload root must be a regular non-link directory: ${root}`);
  }
  const entries: ReleaseSurfaceInstalledPayloadManifestEntry[] = [];
  collectDirectory(root, "", entries, 0);
  entries.sort(compareEntries);
  const manifest: ReleaseSurfaceInstalledPayloadManifest = {
    schema: RELEASE_SURFACE_INSTALLED_PAYLOAD_MANIFEST_SCHEMA,
    platform: input.platform,
    collector: "node-filesystem-v1",
    orchestrator: "native",
    scope: input.scope,
    rootPath: input.recordedRootPath,
    collectedAt: input.collectedAt ?? new Date().toISOString(),
    mainExecutableRelativePath: input.mainExecutableRelativePath.replaceAll("\\", "/"),
    entries,
    entryCount: entries.length,
    totalFileBytes: entries.reduce((sum, entry) => sum + (entry.kind === "file" ? entry.bytes : 0), 0),
    manifestSha256: "",
  };
  manifest.manifestSha256 = releaseSurfaceInstalledPayloadManifestDigest(manifest);
  const errors = validateReleaseSurfaceInstalledPayloadManifest(manifest);
  if (errors.length > 0) throw new Error(`installed payload manifest is invalid: ${errors.join("; ")}`);
  return manifest;
}

function collectReleaseSurfaceWindowsInstalledPayloadManifest(input: {
  recordedRootPath: string;
  platform: "windows-installed";
  scope: ReleaseSurfaceInstalledPayloadManifest["scope"];
  mainExecutableRelativePath: string;
}): ReleaseSurfaceInstalledPayloadManifest {
  const orchestrator = resolveWindowsPayloadOrchestrator();
  const script = resolve(import.meta.dirname, "..", "collect-release-surface-windows-payload.ps1");
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", windowsReadablePayloadPath(script),
    "-RootPath", input.recordedRootPath,
    "-Orchestrator", orchestrator,
  ], { encoding: "utf8", timeout: 5 * 60_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "Windows installed payload collection failed").trim());
  }
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) throw new Error("Windows installed payload collector returned no JSON");
  const observation = JSON.parse(line) as ReleaseSurfaceWindowsPayloadObservation;
  if (observation.schema !== RELEASE_SURFACE_WINDOWS_PAYLOAD_OBSERVATION_SCHEMA
    || observation.collector !== "windows-powershell-payload-v1"
    || observation.orchestrator !== orchestrator
    || normalizeWindowsRoot(observation.rootPath) !== normalizeWindowsRoot(input.recordedRootPath)
    || !Number.isFinite(Date.parse(observation.collectedAt))
    || !Array.isArray(observation.entries)) {
    throw new Error("Windows installed payload collector returned invalid provenance or root identity");
  }
  const entries = observation.entries.map((entry) => ({ ...entry })).sort(compareEntries);
  const manifest: ReleaseSurfaceInstalledPayloadManifest = {
    schema: RELEASE_SURFACE_INSTALLED_PAYLOAD_MANIFEST_SCHEMA,
    platform: "windows-installed",
    collector: "windows-powershell-payload-v1",
    orchestrator,
    scope: input.scope,
    rootPath: input.recordedRootPath,
    collectedAt: observation.collectedAt,
    mainExecutableRelativePath: input.mainExecutableRelativePath.replaceAll("\\", "/"),
    entries,
    entryCount: entries.length,
    totalFileBytes: entries.reduce((sum, entry) => sum + (entry.kind === "file" ? entry.bytes : 0), 0),
    manifestSha256: "",
  };
  manifest.manifestSha256 = releaseSurfaceInstalledPayloadManifestDigest(manifest);
  const errors = validateReleaseSurfaceInstalledPayloadManifest(manifest);
  if (errors.length > 0) throw new Error(`Windows installed payload manifest is invalid: ${errors.join("; ")}`);
  return manifest;
}

export function validateReleaseSurfaceInstalledPayloadManifest(
  manifest: ReleaseSurfaceInstalledPayloadManifest | null | undefined,
): string[] {
  const errors: string[] = [];
  if (!manifest || typeof manifest !== "object") {
    return ["installed payload manifest is required"];
  }
  if (manifest.schema !== RELEASE_SURFACE_INSTALLED_PAYLOAD_MANIFEST_SCHEMA) {
    errors.push(`installed payload manifest schema must be ${RELEASE_SURFACE_INSTALLED_PAYLOAD_MANIFEST_SCHEMA}`);
  }
  if (!( ["windows-installed", "macos-installed", "linux-installed"] as string[]).includes(manifest.platform)) {
    errors.push("installed payload manifest platform is invalid");
  }
  if (manifest.platform === "windows-installed") {
    if (manifest.collector !== "windows-powershell-payload-v1") {
      errors.push("Windows installed payload manifest requires the native PowerShell collector");
    }
    if (!( ["native", "wsl"] as string[]).includes(manifest.orchestrator)) {
      errors.push("Windows installed payload manifest orchestrator must be native or wsl");
    }
  } else {
    if (manifest.collector !== "node-filesystem-v1") errors.push("POSIX installed payload manifest collector is invalid");
    if (manifest.orchestrator !== "native") errors.push("POSIX installed payload manifest orchestrator must be native");
  }
  if (!( ["staged-direct-file", "installer-target-root"] as string[]).includes(manifest.scope)) {
    errors.push("installed payload manifest scope is invalid");
  }
  if (!manifest.rootPath?.trim()) errors.push("installed payload manifest rootPath is required");
  else {
    const rootPathError = validateRootPath(manifest.rootPath, manifest.platform);
    if (rootPathError) errors.push(rootPathError);
  }
  if (!Number.isFinite(Date.parse(manifest.collectedAt))) errors.push("installed payload manifest collectedAt must be valid ISO");
  const mainPathError = validateRelativePath(manifest.mainExecutableRelativePath, "main executable");
  if (mainPathError) errors.push(mainPathError);
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    errors.push("installed payload manifest must contain at least one entry");
    return errors;
  }
  if (manifest.entries.length > 50_000) errors.push("installed payload manifest exceeds the 50000-entry limit");
  if (manifest.entryCount !== manifest.entries.length) errors.push("installed payload manifest entryCount does not match entries");

  let previous = "";
  let totalFileBytes = 0;
  const exactPaths = new Set<string>();
  const windowsPaths = new Set<string>();
  for (const entry of manifest.entries) {
    const pathError = validateRelativePath(entry?.path, "entry");
    if (pathError) errors.push(pathError);
    if (exactPaths.has(entry.path)) errors.push(`installed payload manifest repeats ${entry.path}`);
    exactPaths.add(entry.path);
    if (manifest.platform === "windows-installed") {
      const folded = entry.path.toLowerCase();
      if (windowsPaths.has(folded)) errors.push(`installed payload manifest has a Windows case collision at ${entry.path}`);
      windowsPaths.add(folded);
    }
    if (previous && entry.path <= previous) errors.push("installed payload manifest entries must be strictly path-sorted");
    previous = entry.path;
    if (entry.kind === "file") {
      if (!/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")) errors.push(`installed file ${entry.path} sha256 is invalid`);
      if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) errors.push(`installed file ${entry.path} bytes is invalid`);
      else totalFileBytes += entry.bytes;
    } else if (entry.kind !== "directory") {
      const unsupported = entry as { path?: string; kind?: unknown };
      errors.push(`installed payload entry ${unsupported.path ?? "<unknown>"} has unsupported kind or reparse type`);
    }
  }
  if (manifest.totalFileBytes !== totalFileBytes) errors.push("installed payload manifest totalFileBytes does not match entries");
  const mainEntry = manifest.entries.find((entry) => entry.path === manifest.mainExecutableRelativePath);
  if (!mainEntry || mainEntry.kind !== "file") errors.push("installed payload manifest main executable is not a file entry");
  if (manifest.scope === "staged-direct-file"
    && (manifest.entries.length !== 1 || manifest.entries[0]?.kind !== "file"
      || manifest.entries[0]?.path !== manifest.mainExecutableRelativePath)) {
    errors.push("staged-direct-file manifest must contain exactly the staged main executable");
  }
  if (manifest.manifestSha256 !== releaseSurfaceInstalledPayloadManifestDigest(manifest)) {
    errors.push("installed payload manifest digest does not match its canonical fields");
  }
  return errors;
}

export function releaseSurfaceInstalledPayloadManifestDigest(
  manifest: Omit<ReleaseSurfaceInstalledPayloadManifest, "manifestSha256">,
): string {
  return createHash("sha256").update(JSON.stringify({
    schema: manifest.schema,
    platform: manifest.platform,
    collector: manifest.collector,
    orchestrator: manifest.orchestrator,
    scope: manifest.scope,
    rootPath: manifest.rootPath,
    mainExecutableRelativePath: manifest.mainExecutableRelativePath,
    entries: manifest.entries,
  })).digest("hex");
}

export function sameReleaseSurfaceInstalledPayloadManifest(
  left: ReleaseSurfaceInstalledPayloadManifest,
  right: ReleaseSurfaceInstalledPayloadManifest,
): boolean {
  return left.manifestSha256 === right.manifestSha256
    && left.entryCount === right.entryCount
    && left.totalFileBytes === right.totalFileBytes;
}

export function isReleaseSurfacePathInsideRoot(
  nodeRootPath: string,
  nodeCandidatePath: string,
  platform: ReleasePlatform,
): boolean {
  const fold = (value: string) => platform === "linux-installed" ? value : value.toLowerCase();
  const root = fold(resolve(nodeRootPath));
  const candidate = fold(resolve(nodeCandidatePath));
  const delta = relative(root, candidate);
  return delta === "" || (!delta.startsWith("..") && !isAbsolute(delta));
}

function collectDirectory(
  root: string,
  relativeDirectory: string,
  entries: ReleaseSurfaceInstalledPayloadManifestEntry[],
  depth: number,
): void {
  if (depth > 64) throw new Error("installed payload manifest exceeds the 64-directory-depth limit");
  const directory = relativeDirectory ? join(root, ...relativeDirectory.split("/")) : root;
  for (const name of readdirSync(directory).sort()) {
    const path = relativeDirectory ? `${relativeDirectory}/${name}` : name;
    if (Buffer.byteLength(path, "utf8") > 4096) {
      throw new Error(`installed payload manifest path exceeds 4096 UTF-8 bytes: ${path}`);
    }
    const absolute = join(root, ...path.split("/"));
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`installed payload manifest refuses link or reparse entry ${path}`);
    if (stat.isDirectory()) {
      ensureEntryCapacity(entries);
      entries.push({ path, kind: "directory" });
      collectDirectory(root, path, entries, depth + 1);
    } else if (stat.isFile()) {
      if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
        throw new Error(`installed payload file has an unsupported size: ${path}`);
      }
      ensureEntryCapacity(entries);
      entries.push({
        path,
        kind: "file",
        sha256: hashStableFile(absolute, path, stat),
        bytes: stat.size,
      });
    } else {
      throw new Error(`installed payload manifest refuses unsupported entry ${path}`);
    }
  }
}

function ensureEntryCapacity(entries: ReleaseSurfaceInstalledPayloadManifestEntry[]): void {
  if (entries.length >= 50_000) throw new Error("installed payload manifest exceeds the 50000-entry limit");
}

function hashStableFile(
  absolute: string,
  relative: string,
  before: Stats,
): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(absolute, "r");
  try {
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  const after = lstatSync(absolute);
  if (!after.isFile() || after.isSymbolicLink() || after.size !== before.size
    || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
    throw new Error(`installed payload file changed while hashing: ${relative}`);
  }
  return hash.digest("hex");
}

function compareEntries(
  left: ReleaseSurfaceInstalledPayloadManifestEntry,
  right: ReleaseSurfaceInstalledPayloadManifestEntry,
): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function validateRelativePath(value: string | undefined, label: string): string | null {
  if (!value?.trim() || value !== value.trim()) return `installed payload ${label} path is invalid`;
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)
    || value.includes("\0") || /[\u0000-\u001f]/.test(value)) {
    return `installed payload ${label} path ${value} is not canonical`;
  }
  if (value.split("/").some((part) => !part || part === "." || part === "..")) {
    return `installed payload ${label} path ${value} escapes its root`;
  }
  return null;
}

function validateRootPath(value: string, platform: ReleasePlatform): string | null {
  if (value !== value.trim() || value.includes("\0") || /[\u0000-\u001f]/.test(value)) {
    return "installed payload manifest rootPath is not canonical";
  }
  if (platform === "windows-installed") {
    if (!/^[A-Za-z]:\\[^/]+/.test(value) || value.includes("/") || value.endsWith("\\") || value.includes("\\\\")) {
      return "installed payload manifest Windows rootPath must be a canonical local absolute path";
    }
    if (value.slice(3).split("\\").some((part) => !part || part === "." || part === "..")) {
      return "installed payload manifest Windows rootPath contains a non-canonical segment";
    }
    return null;
  }
  if (!value.startsWith("/") || value === "/" || value.includes("\\") || value.endsWith("/") || value.includes("//")) {
    return "installed payload manifest POSIX rootPath must be a canonical non-root absolute path";
  }
  if (value.slice(1).split("/").some((part) => !part || part === "." || part === "..")) {
    return "installed payload manifest POSIX rootPath contains a non-canonical segment";
  }
  return null;
}

function resolveWindowsPayloadOrchestrator(): "native" | "wsl" {
  if (process.platform === "win32") return "native";
  if (process.platform === "linux" && process.env.WSL_INTEROP?.trim()) return "wsl";
  throw new Error("Windows installed payload collection requires native Windows or WSL interop");
}

function windowsReadablePayloadPath(path: string): string {
  if (process.platform === "win32") return path;
  const result = spawnSync("wslpath", ["-w", path], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(`unable to map Windows payload collector path ${path}`);
  return result.stdout.trim();
}

function normalizeWindowsRoot(value: string): string {
  return value.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
}
