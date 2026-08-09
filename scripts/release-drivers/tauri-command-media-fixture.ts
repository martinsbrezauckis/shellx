import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve, win32 } from "node:path";
import { releaseSurfaceProfileLaunchRootFromDebugTokenPath } from "../lib/release-surface-run-profile";
import type { ReleaseSurfaceDriverRequest } from "../lib/release-surface-driver-protocol";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const FIXTURE_NAME = "shellx-final-media.png";

export type TauriCommandMediaFixture = {
  apiPath: string;
  localPath: string;
  sessionCwd: string;
  expectedDataUrl: string;
};

export function prepareTauriCommandMediaFixture(
  request: ReleaseSurfaceDriverRequest,
): TauriCommandMediaFixture {
  const sessionCwd = releaseSurfaceProfileLaunchRootFromDebugTokenPath(
    request.runtime.debugTokenPath,
    request.platform,
  );
  const apiPath = request.platform === "windows-installed" && /^[A-Za-z]:[\\/]/.test(sessionCwd)
    ? win32.join(sessionCwd, FIXTURE_NAME)
    : join(sessionCwd, FIXTURE_NAME);
  const localPath = nodeReadablePath(apiPath, request.platform);
  writeFileSync(localPath, Buffer.from(PNG_BASE64, "base64"), { flag: "wx", mode: 0o600 });
  return {
    apiPath,
    localPath,
    sessionCwd,
    expectedDataUrl: `data:image/png;base64,${PNG_BASE64}`,
  };
}

export function cleanupTauriCommandMediaFixture(fixture: TauriCommandMediaFixture): string | null {
  try {
    if (basename(fixture.localPath) !== FIXTURE_NAME) throw new Error("refused to clean an unowned media fixture path");
    if (existsSync(fixture.localPath)) rmSync(fixture.localPath);
    if (existsSync(fixture.localPath)) throw new Error("owned media fixture remained after exact cleanup");
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
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
    throw new Error("unable to map the Tauri media fixture path into WSL");
  }
  return resolve(result.stdout.trim());
}
