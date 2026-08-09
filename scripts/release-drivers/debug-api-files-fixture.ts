import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, win32 } from "node:path";
import type { ReleaseSurfaceDriverRequest } from "../lib/release-surface-driver-protocol";

export type DebugApiFilesFixture = {
  apiPath: string;
  localPath: string;
  tabId: string;
  directoryName: string;
  fileName: string;
  hiddenName: string;
  fileSize: number;
};

export function prepareDebugApiFilesFixture(
  request: ReleaseSurfaceDriverRequest,
): DebugApiFilesFixture {
  const segment = request.sourceCommit.slice(0, 16).replace(/[^a-f0-9]/g, "0");
  const directoryName = `release-directory-${segment}`;
  const fileName = `release-file-${segment}.txt`;
  const hiddenName = `.release-hidden-${segment}`;
  const tabId = `release-files-${segment}`;
  const apiPath = siblingPath(
    request.runtime.debugTokenPath,
    `release-surface-files-${segment}`,
    request.platform,
  );
  const localPath = nodeReadablePath(apiPath, request.platform);
  const content = `ShellX release Files surface ${segment}\n`;
  const fixture: DebugApiFilesFixture = {
    apiPath,
    localPath,
    tabId,
    directoryName,
    fileName,
    hiddenName,
    fileSize: Buffer.byteLength(content),
  };
  mkdirSync(localPath, { mode: 0o700 });
  try {
    mkdirSync(join(localPath, directoryName), { mode: 0o700 });
    writeFileSync(join(localPath, fileName), content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    writeFileSync(join(localPath, hiddenName), "owned hidden sentinel\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return fixture;
  } catch (error) {
    const cleanupError = cleanupDebugApiFilesFixture(fixture);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(cleanupError ? `${message}; cleanup: ${cleanupError}` : message);
  }
}

export function cleanupDebugApiFilesFixture(fixture: DebugApiFilesFixture): string | null {
  try {
    unlinkIfPresent(join(fixture.localPath, fixture.fileName));
    unlinkIfPresent(join(fixture.localPath, fixture.hiddenName));
    rmdirIfPresent(join(fixture.localPath, fixture.directoryName));
    rmdirIfPresent(fixture.localPath);
    if (existsSync(fixture.localPath)) throw new Error("owned Files fixture remained after exact cleanup");
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function debugApiFilesRequestPath(
  path: string,
  fixture: DebugApiFilesFixture | null,
): string {
  if (path !== "/state/files") return path;
  const owned = requireFixture(fixture);
  const query = new URLSearchParams({
    tabId: owned.tabId,
    path: owned.apiPath,
    includeHidden: "false",
  });
  return `${path}?${query}`;
}

export function verifyDebugApiFilesJson(
  path: string,
  value: unknown,
  fixture: DebugApiFilesFixture | null,
): string | null {
  if (path !== "/state/files") return null;
  const owned = requireFixture(fixture);
  const body = requireObject(value, path);
  if (body.tabId !== owned.tabId || body.path !== owned.apiPath
    || body.connectionId !== null || body.includeHidden !== false || body.count !== 2) {
    throw new Error("Files state omitted its exact local path, tab, hidden policy, or entry count");
  }
  if (!Array.isArray(body.entries) || body.entries.length !== 2) {
    throw new Error("Files state did not return exactly the owned visible entries");
  }
  const directory = requireObject(body.entries[0], `${path}.entries[0]`);
  const file = requireObject(body.entries[1], `${path}.entries[1]`);
  if (directory.name !== owned.directoryName || directory.kind !== "dir"
    || !Number.isSafeInteger(directory.size) || directory.git_status !== null) {
    throw new Error("Files state did not return the owned directory first");
  }
  if (file.name !== owned.fileName || file.kind !== "file" || file.size !== owned.fileSize
    || file.git_status !== null) {
    throw new Error("Files state did not return the exact owned visible file metadata");
  }
  if (JSON.stringify(body).includes(owned.hiddenName)) {
    throw new Error("Files state exposed the owned hidden sentinel while includeHidden was false");
  }
  return "Files state returned one exact directory followed by one exact visible file, filtered its hidden sentinel, and retained no path or names in release evidence.";
}

function siblingPath(
  tokenPath: string,
  name: string,
  platform: ReleaseSurfaceDriverRequest["platform"],
): string {
  if (platform === "windows-installed" && /^[A-Za-z]:[\\/]/.test(tokenPath)) {
    return win32.join(win32.dirname(tokenPath), name);
  }
  return join(dirname(tokenPath), name);
}

function nodeReadablePath(
  path: string,
  platform: ReleaseSurfaceDriverRequest["platform"],
): string {
  if (platform !== "windows-installed" || process.platform === "win32" || !/^[A-Za-z]:[\\/]/.test(path)) {
    return resolve(path);
  }
  const result = spawnSync("wslpath", ["-u", path], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error("unable to map the Debug API Files fixture path into WSL");
  }
  return resolve(result.stdout.trim());
}

function unlinkIfPresent(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

function rmdirIfPresent(path: string): void {
  if (existsSync(path)) rmdirSync(path);
}

function requireFixture(value: DebugApiFilesFixture | null): DebugApiFilesFixture {
  if (!value) throw new Error("owned Files fixture is unavailable");
  return value;
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} did not return an object`);
  }
  return value as Record<string, unknown>;
}
