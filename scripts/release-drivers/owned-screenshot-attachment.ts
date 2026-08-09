import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, join, resolve, win32 } from "node:path";
import {
  RELEASE_SURFACE_RUN_PROFILE_SCHEMA,
  releaseSurfaceProfileLaunchRootFromDebugTokenPath,
  releaseSurfaceProfileMarkerLaunchPath,
} from "../lib/release-surface-run-profile";
import {
  observeReleaseSurfaceInstalledInputElement,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import type { ReleaseSurfaceDriverRequest } from "../lib/release-surface-driver-protocol";

export type OwnedScreenshotAttachmentProof = {
  localDir: string;
  launchDir: string;
  baselineNames: Set<string>;
  createdLocalPath?: string;
};

export function prepareOwnedScreenshotAttachmentProof(
  request: ReleaseSurfaceDriverRequest,
): OwnedScreenshotAttachmentProof {
  const launchRoot = releaseSurfaceProfileLaunchRootFromDebugTokenPath(
    request.runtime.debugTokenPath,
    request.platform,
  );
  verifyIsolatedRunProfile(request, launchRoot);
  const windows = request.platform === "windows-installed";
  const launchDir = windows
    ? win32.join(launchRoot, ".grok", "shellx-screenshots")
    : join(launchRoot, ".grok", "shellx-screenshots");
  const localDir = nodeReadablePath(launchDir, request.platform);
  return { localDir, launchDir, baselineNames: ownedScreenshotNames(localDir) };
}

export async function waitForOwnedScreenshotAttachment(
  proof: OwnedScreenshotAttachmentProof,
): Promise<{ localPath: string; launchPath: string }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const created = [...ownedScreenshotNames(proof.localDir)].filter((name) => !proof.baselineNames.has(name));
    if (created.length > 1) throw new Error("screenshot action created more than one owned screenshot file");
    if (created.length === 1) {
      const name = created[0]!;
      const localPath = join(proof.localDir, name);
      const stat = lstatSync(localPath);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 8) {
        throw new Error("screenshot action did not create one regular non-empty PNG file");
      }
      const signature = readFileSync(localPath).subarray(0, 8).toString("hex");
      if (signature !== "89504e470d0a1a0a") throw new Error("screenshot action output did not have a PNG signature");
      const launchPath = /^[A-Za-z]:[\\/]/.test(proof.launchDir)
        ? win32.join(proof.launchDir, name)
        : join(proof.launchDir, name);
      return { localPath, launchPath };
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("screenshot action did not create its owned PNG before timeout");
}

export async function verifyOwnedScreenshotAttachmentChip(
  input: ReleaseSurfaceInstalledInputSession,
  expectedPath: string,
): Promise<void> {
  const observed = await observeReleaseSurfaceInstalledInputElement(
    input,
    ".composer-attachment-chip.composer-attachment-image",
    ["title"],
  );
  if (!observed.present || !observed.visible || observed.title !== expectedPath) {
    throw new Error("composer did not attach the exact owned screenshot path");
  }
}

export function cleanupOwnedScreenshotAttachmentProof(
  proof: OwnedScreenshotAttachmentProof | null,
): void {
  if (!proof) return;
  const created = [...ownedScreenshotNames(proof.localDir)].filter((name) => !proof.baselineNames.has(name));
  for (const name of created) {
    const localPath = join(proof.localDir, name);
    if (proof.createdLocalPath && resolve(localPath) !== resolve(proof.createdLocalPath)) {
      throw new Error("refused to clean an unexpected screenshot file");
    }
    rmSync(localPath);
  }
  const remaining = [...ownedScreenshotNames(proof.localDir)].filter((name) => !proof.baselineNames.has(name));
  if (remaining.length !== 0) throw new Error("owned screenshot remained after exact cleanup");
}

function verifyIsolatedRunProfile(request: ReleaseSurfaceDriverRequest, launchRoot: string): void {
  const rootName = request.platform === "windows-installed" ? win32.basename(launchRoot) : basename(launchRoot);
  const runId = rootName.match(/^shellx-final-webdriver-([a-f0-9]{16,64})$/)?.[1];
  if (!runId) throw new Error("screenshot proof requires the exact isolated final-run profile name");
  const markerLaunchPath = releaseSurfaceProfileMarkerLaunchPath(
    request.runtime.debugTokenPath,
    request.platform,
  );
  const markerLocalPath = nodeReadablePath(markerLaunchPath, request.platform);
  const stat = lstatSync(markerLocalPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("screenshot proof requires a regular isolated run-profile marker");
  }
  const marker = JSON.parse(readFileSync(markerLocalPath, "utf8")) as Record<string, unknown>;
  if (marker.schema !== RELEASE_SURFACE_RUN_PROFILE_SCHEMA
    || marker.platform !== request.platform
    || marker.runId !== runId
    || marker.launchPath !== launchRoot) {
    throw new Error("screenshot proof run-profile marker does not match the exact candidate profile");
  }
}

function ownedScreenshotNames(localDir: string): Set<string> {
  if (!existsSync(localDir)) return new Set();
  const stat = lstatSync(localDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("screenshot directory is not a regular directory");
  return new Set(readdirSync(localDir).filter((name) => /^shellx-screenshot-\d+\.png$/.test(name)));
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
    throw new Error("unable to map the isolated screenshot directory into WSL");
  }
  return resolve(result.stdout.trim());
}
