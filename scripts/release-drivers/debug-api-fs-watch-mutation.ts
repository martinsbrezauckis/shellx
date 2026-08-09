import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";

const FS_WATCH_MUTATIONS = new Set([
  "POST /tools/fs_watch",
  "DELETE /tools/fs_watch/:watchId",
]);
const TIMEOUT_MS = 30_000;

type DebugApiConnection = { base: string; token: string };
type DriverAssignment = ReleaseSurfaceDriverRequest["assignments"][number];

type FsWatchFixture = {
  apiDirectory: string;
  nodeDirectory: string;
  apiMarker: string;
  nodeMarker: string;
};

export function isDebugApiFsWatchMutation(name: string): boolean {
  return FS_WATCH_MUTATIONS.has(name);
}

export async function exerciseDebugApiFsWatchMutation(
  connection: DebugApiConnection,
  request: ReleaseSurfaceDriverRequest,
  assignment: DriverAssignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome: ReleaseSurfaceDriverOutcome = {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No exact owned filesystem-watch lifecycle was observed.",
  };
  let fixture: FsWatchFixture | null = null;
  let watchId: string | null = null;
  const cleanupWatchIds = new Set<string>();
  try {
    if (!FS_WATCH_MUTATIONS.has(assignment.surface.name)) {
      throw new Error(`unsupported filesystem-watch route ${assignment.surface.name}`);
    }
    fixture = prepareFsWatchFixture(request, assignment.surface.name);
    outcome.present = "pass";

    const started = await apiJson(connection, "POST", "/tools/fs_watch", {
      path: fixture.apiDirectory,
      recursive: false,
      debounceMs: 50,
    });
    outcome.invoke = "pass";
    verifyExactKeys(started, [
      "alreadyWatching", "debounce_ms", "ok", "recursive", "started_at_ms",
      "watchId", "watching",
    ], "filesystem watch start response");
    watchId = requiredString(started.watchId, "filesystem watch ID");
    cleanupWatchIds.add(watchId);
    const watching = requiredString(started.watching, "filesystem watch path");
    if (!/^fsw-[0-9a-f-]{36}$/.test(watchId) || started.ok !== true
      || started.alreadyWatching !== false || started.recursive !== false
      || started.debounce_ms !== 50 || !Number.isSafeInteger(started.started_at_ms)
      || Number(started.started_at_ms) <= 0
      || !sameNativePath(watching, fixture.apiDirectory, request.platform)) {
      throw new Error("filesystem watch start omitted its exact owned registration");
    }

    const deduped = await apiJson(connection, "POST", "/tools/fs_watch", {
      path: fixture.apiDirectory,
      recursive: false,
      debounce_ms: 50,
    });
    verifyExactKeys(deduped, [
      "alreadyWatching", "debounce_ms", "ok", "recursive", "started_at_ms",
      "watchId", "watching",
    ], "filesystem watch dedupe response");
    const dedupedWatchId = requiredString(deduped.watchId, "deduped filesystem watch ID");
    cleanupWatchIds.add(dedupedWatchId);
    if (deduped.ok !== true || dedupedWatchId !== watchId || deduped.alreadyWatching !== true
      || deduped.recursive !== false || deduped.debounce_ms !== 50
      || deduped.started_at_ms !== started.started_at_ms
      || !sameNativePath(requiredString(deduped.watching, "deduped filesystem watch path"), watching, request.platform)) {
      throw new Error("filesystem watch did not deduplicate its exact owned registration");
    }

    await delay(100);
    writeFileSync(fixture.nodeMarker, "ShellX final release filesystem-watch marker\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await waitForExactFsWatchEvent(connection, watchId, watching, fixture.apiMarker, request.platform);

    const deleted = await apiJson(
      connection,
      "DELETE",
      `/tools/fs_watch/${encodeURIComponent(watchId)}`,
    );
    verifyExactKeys(deleted, ["ok", "stopped", "taskOutcome", "watchId"], "filesystem unwatch response");
    if (deleted.ok !== true || deleted.watchId !== watchId || deleted.stopped !== true
      || !["cancelled", "completed"].includes(String(deleted.taskOutcome))) {
      throw new Error("filesystem unwatch did not stop its exact owned registration");
    }
    cleanupWatchIds.delete(watchId);

    const absent = await apiJson(
      connection,
      "DELETE",
      `/tools/fs_watch/${encodeURIComponent(watchId)}`,
      undefined,
      404,
    );
    verifyExactKeys(absent, ["message", "ok", "stopped", "watchId"], "filesystem unwatch absent response");
    if (absent.ok !== false || absent.watchId !== watchId || absent.stopped !== false
      || absent.message !== "filesystem watch not found") {
      throw new Error("filesystem unwatch did not prove exact registration removal");
    }

    outcome.effect = "pass";
    outcome.observedEffect = `${assignment.surface.name} created one native-temp watcher, deduplicated it, observed its exact owned marker event, stopped it, and proved the watch ID absent.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    for (const cleanupWatchId of cleanupWatchIds) {
      try {
        const response = await apiJson(
          connection,
          "DELETE",
          `/tools/fs_watch/${encodeURIComponent(cleanupWatchId)}`,
          undefined,
          [200, 404],
        );
        if (response.watchId !== cleanupWatchId || (response.stopped !== true && response.stopped !== false)) {
          throw new Error("owned filesystem watcher cleanup returned the wrong identity");
        }
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (fixture) {
      const error = cleanupFsWatchFixture(fixture);
      if (error) cleanupErrors.push(error);
    }
    if (cleanupErrors.length === 0) {
      outcome.cleanup = "pass";
    } else {
      const cleanup = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${cleanup}` : `cleanup: ${cleanup}`;
    }
  }
  return outcome;
}

function prepareFsWatchFixture(
  request: ReleaseSurfaceDriverRequest,
  surfaceName: string,
): FsWatchFixture {
  const segment = request.sourceCommit.slice(0, 16).replace(/[^a-f0-9]/g, "0");
  const lane = surfaceName.startsWith("DELETE") ? "delete" : "post";
  const directoryName = `shellx-release-fs-watch-${lane}-${segment}-${randomUUID()}`;
  const markerName = `release-owned-fs-watch-${lane}-${segment}.txt`;
  const apiTemp = nativeTempPath(request.platform);
  const apiDirectory = platformJoin(apiTemp, directoryName, request.platform);
  const nodeDirectory = nodeReadablePath(apiDirectory, request.platform);
  const apiMarker = platformJoin(apiDirectory, markerName, request.platform);
  const nodeMarker = join(nodeDirectory, markerName);
  mkdirSync(nodeDirectory, { mode: 0o700 });
  return { apiDirectory, nodeDirectory, apiMarker, nodeMarker };
}

function cleanupFsWatchFixture(fixture: FsWatchFixture): string | null {
  try {
    if (existsSync(fixture.nodeMarker)) unlinkSync(fixture.nodeMarker);
    if (existsSync(fixture.nodeDirectory)) rmdirSync(fixture.nodeDirectory);
    if (existsSync(fixture.nodeMarker) || existsSync(fixture.nodeDirectory)) {
      throw new Error("owned filesystem-watch fixture remained after exact cleanup");
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function waitForExactFsWatchEvent(
  connection: DebugApiConnection,
  watchId: string,
  watching: string,
  markerPath: string,
  platform: ReleaseSurfaceDriverRequest["platform"],
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${connection.base}/events/recent?limit=1000`, {
      headers: { Authorization: `Bearer ${connection.token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GET /events/recent failed ${response.status}`);
    const value = await response.json();
    if (!Array.isArray(value)) throw new Error("filesystem-watch event readback was not an array");
    const match = value.find((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      const row = candidate as Record<string, unknown>;
      if (row.kind !== "fs-watch" || !row.payload || typeof row.payload !== "object" || Array.isArray(row.payload)) return false;
      const payload = row.payload as Record<string, unknown>;
      return payload.watchId === watchId
        && typeof payload.path === "string"
        && sameNativePath(payload.path, markerPath, platform);
    }) as Record<string, unknown> | undefined;
    if (match) {
      verifyExactKeys(match, ["kind", "payload", "t"], "filesystem-watch event envelope");
      const payload = requireObject(match.payload, "filesystem-watch event payload");
      verifyExactKeys(payload, ["kind", "path", "t", "tMs", "watchId", "watching"], "filesystem-watch event payload");
      if (!Number.isSafeInteger(match.t) || !Number.isSafeInteger(payload.t)
        || payload.t !== payload.tMs || !["created", "modified"].includes(String(payload.kind))
        || payload.watchId !== watchId
        || !sameNativePath(requiredString(payload.watching, "filesystem-watch event root"), watching, platform)) {
        throw new Error("filesystem-watch event omitted its exact bounded identity");
      }
      return;
    }
    await delay(50);
  }
  throw new Error("filesystem watch did not emit the exact owned marker event before timeout");
}

function nativeTempPath(platform: ReleaseSurfaceDriverRequest["platform"]): string {
  if (platform !== "windows-installed") return tmpdir();
  if (process.platform === "win32") return tmpdir();
  const result = spawnSync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "[Console]::Out.Write([IO.Path]::GetTempPath())",
  ], { encoding: "utf8", timeout: 10_000 });
  const value = result.stdout.trim();
  if (result.status !== 0 || !/^[A-Za-z]:[\\/]/.test(value)) {
    throw new Error("unable to resolve the Windows native temporary directory");
  }
  return value;
}

function platformJoin(
  parent: string,
  child: string,
  platform: ReleaseSurfaceDriverRequest["platform"],
): string {
  return platform === "windows-installed" ? win32.join(parent, child) : join(parent, child);
}

function nodeReadablePath(path: string, platform: ReleaseSurfaceDriverRequest["platform"]): string {
  if (platform !== "windows-installed" || process.platform === "win32") return resolve(path);
  const result = spawnSync("wslpath", ["-u", path], { encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error("unable to map the Windows filesystem-watch fixture path into WSL");
  }
  return resolve(result.stdout.trim());
}

function sameNativePath(
  left: string,
  right: string,
  platform: ReleaseSurfaceDriverRequest["platform"],
): boolean {
  if (platform === "windows-installed") {
    return normalizeWindowsPath(left) === normalizeWindowsPath(right);
  }
  const normalize = (value: string): string => {
    try {
      return realpathSync(value);
    } catch {
      return resolve(value);
    }
  };
  return normalize(left) === normalize(right);
}

function normalizeWindowsPath(value: string): string {
  return win32.normalize(value.replace(/^\\\\\?\\/, "")).replace(/[\\/]+$/, "").toLowerCase();
}

async function apiJson(
  connection: DebugApiConnection,
  method: "POST" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
  expectedStatus: number | number[] = 200,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  const statuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  if (!statuses.includes(response.status)) {
    throw new Error(`${method} ${path} failed ${response.status}: ${text.slice(0, 1_200)}`);
  }
  return requireObject(text.trim() ? JSON.parse(text) : {}, `${method} ${path}`);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} was not an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} was not a non-empty string`);
  return value;
}

function verifyExactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} returned unexpected keys`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
