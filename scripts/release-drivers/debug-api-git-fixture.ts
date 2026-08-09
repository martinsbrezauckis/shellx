import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import type { ReleaseSurfaceDriverRequest } from "../lib/release-surface-driver-protocol";

export type DebugApiGitFixture = {
  apiPath: string;
  localPath: string;
  rootName: string;
  tabId: string;
  trackedName: string;
  untrackedName: string;
  marker: string;
  checkpointPaths: string[];
  checkpointRoot: string | null;
};

export function isDebugApiGitPath(path: string): boolean {
  return path === "/state/github" || path === "/state/github/items"
    || path === "/state/session_git" || path === "/state/session_git/diff"
    || path === "/state/session_git/checkpoint" || path === "/state/session_git/worktree";
}

export function prepareDebugApiGitFixture(
  request: ReleaseSurfaceDriverRequest,
): DebugApiGitFixture {
  const segment = request.sourceCommit.slice(0, 16).replace(/[^a-f0-9]/g, "0");
  const rootName = `release-surface-git-${segment}`;
  const apiPath = siblingPath(request.runtime.debugTokenPath, rootName, request.platform);
  const localPath = nodeReadablePath(apiPath, request.platform);
  const fixture: DebugApiGitFixture = {
    apiPath,
    localPath,
    rootName,
    tabId: `release-git-${segment}`,
    trackedName: `tracked-${segment}.txt`,
    untrackedName: `untracked-${segment}.txt`,
    marker: `SHELLX_RELEASE_GIT_DIFF_${segment}`,
    checkpointPaths: [],
    checkpointRoot: null,
  };
  mkdirSync(localPath, { mode: 0o700 });
  try {
    runGit(localPath, ["init"]);
    runGit(localPath, ["config", "user.name", "ShellX Release Driver"]);
    runGit(localPath, ["config", "user.email", "release-driver@localhost"]);
    runGit(localPath, ["checkout", "-b", "release-proof"]);
    writeFileSync(join(localPath, fixture.trackedName), "ShellX release Git baseline\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    runGit(localPath, ["add", "--", fixture.trackedName]);
    runGit(localPath, ["-c", "core.hooksPath=/dev/null", "commit", "-m", "release baseline"]);
    writeFileSync(
      join(localPath, fixture.trackedName),
      `ShellX release Git baseline\n${fixture.marker}\n`,
      { encoding: "utf8", flag: "w", mode: 0o600 },
    );
    writeFileSync(join(localPath, fixture.untrackedName), "owned untracked sentinel\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return fixture;
  } catch (error) {
    const cleanupError = cleanupDebugApiGitFixture(fixture);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(cleanupError ? `${message}; cleanup: ${cleanupError}` : message);
  }
}

export function cleanupDebugApiGitFixture(fixture: DebugApiGitFixture): string | null {
  try {
    if (basename(fixture.localPath) !== fixture.rootName || !fixture.rootName.startsWith("release-surface-git-")) {
      throw new Error("refused to clean an unowned Git fixture path");
    }
    for (const checkpointPath of fixture.checkpointPaths) {
      if (existsSync(checkpointPath)) rmSync(checkpointPath, { recursive: true });
      if (existsSync(checkpointPath)) throw new Error("owned Git checkpoint remained after exact cleanup");
      let parent = dirname(checkpointPath);
      while (fixture.checkpointRoot && parent !== fixture.checkpointRoot) {
        const ownedRelative = relative(fixture.checkpointRoot, parent);
        if (!ownedRelative || ownedRelative.startsWith("..") || isAbsolute(ownedRelative)
          || !existsSync(parent) || readdirSync(parent).length > 0) break;
        rmdirSync(parent);
        parent = dirname(parent);
      }
    }
    if (existsSync(fixture.localPath)) rmSync(fixture.localPath, { recursive: true });
    if (existsSync(fixture.localPath)) throw new Error("owned Git fixture remained after exact cleanup");
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function trackDebugApiGitCheckpointPath(
  fixture: DebugApiGitFixture,
  checkpointApiPath: string,
  checkpointId: string,
  request: ReleaseSurfaceDriverRequest,
): string {
  const checkpointPath = nodeReadablePath(checkpointApiPath, request.platform);
  const checkpointRoot = nodeReadablePath(
    siblingPath(request.runtime.debugTokenPath, "git-checkpoints", request.platform),
    request.platform,
  );
  const ownedRelative = relative(checkpointRoot, checkpointPath);
  if (!ownedRelative || ownedRelative.startsWith("..") || isAbsolute(ownedRelative)
    || basename(checkpointPath) !== checkpointId) {
    throw new Error("checkpoint response escaped the installed profile's owned git-checkpoints root");
  }
  if (!existsSync(checkpointPath)) throw new Error("checkpoint response path does not exist");
  fixture.checkpointRoot = checkpointRoot;
  fixture.checkpointPaths.push(checkpointPath);
  return checkpointPath;
}

export function debugApiGitWorktreePaths(
  fixture: DebugApiGitFixture,
  branch: string,
  request: ReleaseSurfaceDriverRequest,
): { apiPath: string; localPath: string } {
  const apiPath = request.platform === "windows-installed" && /^[A-Za-z]:[\\/]/.test(fixture.apiPath)
    ? win32.join(fixture.apiPath, ".worktrees", branch)
    : join(fixture.apiPath, ".worktrees", branch);
  return { apiPath, localPath: nodeReadablePath(apiPath, request.platform) };
}

export function debugApiGitRequestPath(
  path: string,
  fixture: DebugApiGitFixture | null,
): string {
  if (!isDebugApiGitPath(path)) return path;
  const owned = requireFixture(fixture);
  if (path === "/state/session_git/checkpoint" || path === "/state/session_git/worktree") return path;
  const query = new URLSearchParams({
    tabId: owned.tabId,
    cwd: owned.apiPath,
    ...(path.endsWith("/diff") ? { scope: "head" } : {}),
  });
  return `${path}?${query}`;
}

export function verifyDebugApiGitJson(
  path: string,
  value: unknown,
  fixture: DebugApiGitFixture | null,
): string | null {
  if (!isDebugApiGitPath(path)) return null;
  const owned = requireFixture(fixture);
  const body = requireObject(value, path);
  if (path === "/state/github/items") {
    requireExactKeys(body, ["items"], path);
    if (!Array.isArray(body.items)) throw new Error("GitHub items omitted its exact bounded array");
    if (body.items.length > 100) throw new Error("GitHub items exceeded its two 50-item provider bounds");
    for (const [index, itemValue] of body.items.entries()) {
      const item = requireObject(itemValue, `${path}.items[${index}]`);
      if (!Number.isSafeInteger(item.number) || typeof item.title !== "string"
        || typeof item.url !== "string" || !["pr", "issue"].includes(String(item.kind))) {
        throw new Error("GitHub items returned an entry outside the normalized PR/issue contract");
      }
    }
    return `GitHub items returned ${body.items.length} normalized open PR/issue item${body.items.length === 1 ? "" : "s"} from the owned no-remote repository; cwd and item contents were not retained.`;
  }
  if (path === "/state/github") {
    requireExactKeys(body, ["ahead", "behind", "branch", "cwd", "remote", "staged"], path);
    if (body.cwd !== owned.apiPath || body.branch !== "release-proof" || body.remote !== null
      || body.ahead !== null || body.behind !== null || body.staged !== "") {
      throw new Error("GitHub status omitted the exact owned local repository state");
    }
    return "GitHub status inspected the exact owned local repository without an upstream or remote; cwd and branch were not retained.";
  }
  if (path === "/state/session_git") {
    if (body.ok !== true || body.tabId !== owned.tabId || body.transport !== "local"
      || body.cwd !== owned.apiPath || body.repoScope !== "cwd" || body.clean !== false
      || body.staged !== 0 || body.unstaged !== 1 || body.untracked !== 1
      || body.conflicts !== 0 || body.deleted !== 0 || body.lastError !== null
      || typeof body.head !== "string" || !body.head
      || typeof body.repoRoot !== "string" || !body.repoRoot) {
      throw new Error("session Git status omitted the exact owned dirty repository state");
    }
    if (!Array.isArray(body.files) || body.files.length !== 2) {
      throw new Error("session Git status did not return the two exact owned changes");
    }
    const tracked = body.files.map((entry) => requireObject(entry, `${path}.file`))
      .find((entry) => entry.path === owned.trackedName);
    const untracked = body.files.map((entry) => requireObject(entry, `${path}.file`))
      .find((entry) => entry.path === owned.untrackedName);
    if (!tracked || tracked.index !== " " || tracked.worktree !== "M"
      || !untracked || untracked.index !== "?" || untracked.worktree !== "?") {
      throw new Error("session Git status did not preserve the exact tracked and untracked classifications");
    }
    return "Session Git returned one exact unstaged edit and one exact untracked file from an owned repository; path, branch, head, and filenames were not retained.";
  }
  if (body.ok !== true || body.scope !== "head" || body.truncated !== false
    || body.lastError !== null || typeof body.diff !== "string"
    || !body.diff.includes(owned.trackedName) || !body.diff.includes(owned.marker)
    || !Number.isSafeInteger(body.bytes) || body.bytes !== Buffer.byteLength(body.diff)) {
    throw new Error("session Git diff omitted the exact bounded owned HEAD diff");
  }
  return "Session Git diff returned the exact owned working-tree patch with a matching byte count and no truncation; repository path, filename, and diff content were not retained.";
}

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0) {
    throw new Error(`owned Git fixture command failed with status ${result.status ?? "unknown"}`);
  }
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
    throw new Error("unable to map the Debug API Git fixture path into WSL");
  }
  return resolve(result.stdout.trim());
}

function requireFixture(value: DebugApiGitFixture | null): DebugApiGitFixture {
  if (!value) throw new Error("owned Git fixture is unavailable");
  return value;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} did not return an object`);
  return value as Record<string, unknown>;
}

function requireExactKeys(body: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(body).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} returned unexpected keys: ${actual.join(", ")}`);
  }
}
