import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ReleaseSurfaceRunProfileCleanupError,
  cleanupReleaseSurfaceRunProfile,
  prepareReleaseSurfaceRunProfile,
  releaseSurfaceProfileLaunchRootFromDebugTokenPath,
  releaseSurfaceProfileMarkerLaunchPath,
} from "./lib/release-surface-run-profile";

const runProfileSource = readFileSync(new URL("./lib/release-surface-run-profile.ts", import.meta.url), "utf8");
const macosFinalizerSource = readFileSync(new URL("./finalize-release-surface-macos-candidate.ts", import.meta.url), "utf8");
assert(runProfileSource.includes("netstat.exe"));
assert(runProfileSource.includes("Get-Process -Id $appPid"));
assert(runProfileSource.includes("readFileSync(`/proc/${pid}/stat`"));
assert(runProfileSource.includes('spawnSync("/usr/sbin/lsof"'));
assert(runProfileSource.includes('platform: Extract<ReleasePlatform, "windows-installed" | "macos-installed" | "linux-installed">'));
assert(macosFinalizerSource.includes("cleanupReleaseSurfaceRunProfile"));
assert(macosFinalizerSource.includes("createReleaseSurfaceCandidateTeardownReceipt"));
assert(!runProfileSource.includes("Get-CimInstance"));
assert(!runProfileSource.includes("Get-NetTCPConnection"));

assert.equal(
  releaseSurfaceProfileLaunchRootFromDebugTokenPath(
    "C:\\Users\\Fixture\\shellx-final-webdriver-0123456789abcdef\\.shellx\\shellxagent.token",
    "windows-installed",
  ),
  "C:\\Users\\Fixture\\shellx-final-webdriver-0123456789abcdef",
);
assert.equal(
  releaseSurfaceProfileMarkerLaunchPath(
    "/Users/fixture/shellx-final-webdriver-0123456789abcdef/.shellx/shellxagent.token",
    "macos-installed",
  ),
  "/Users/fixture/shellx-final-webdriver-0123456789abcdef/shellx-final-profile.json",
);
assert.throws(
  () => releaseSurfaceProfileLaunchRootFromDebugTokenPath("/tmp/unrelated.token", "linux-installed"),
  /exact \.shellx token location/,
);

const temp = mkdtempSync(join(tmpdir(), "shellx-final-profile-test-"));
const hostPlatform = process.platform === "win32"
  ? "windows-installed"
  : process.platform === "darwin"
    ? "macos-installed"
    : "linux-installed";
let child: ChildProcess | null = null;
try {
  const runId = "a".repeat(16);
  const profilePath = join(temp, `shellx-final-webdriver-${runId}`);
  const profile = prepareReleaseSurfaceRunProfile({
    platform: hostPlatform,
    runId,
    nodePath: profilePath,
    launchPath: profilePath,
    debugPort: 31_001,
    mcpPort: 31_002,
    baseEnvironment: { PATH: process.env.PATH },
  });
  assert.equal(profile.environment.HOME, profilePath);
  assert.equal(profile.environment.SHELLX_DEBUG_PORT, "31001");
  assert.equal(profile.environment.SHELLX_MCP_PORT, "31002");
  assert.equal(profile.environment.SHELLX_MCP_MARKETPLACE_E2E, "1");
  assert.equal(profile.environment.SHELLX_MCP_SECRET, undefined);
  assert.equal(profile.environment.SHELLX_TEST_INSTANCE_ID, `shellx-final-${runId}`);
  assert.equal(profile.environment.SHELLX_VAULT_PROFILE_DIR, join(profilePath, "vault-e2e"));
  assert.equal(profile.debugTokenNodePath, join(profilePath, ".shellx", "shellxagent.token"));
  assert.equal(profile.mcpBase, "http://127.0.0.1:31002");
  assert.equal(profile.mcpTokenNodePath, join(profilePath, ".shellx", "mcp.token"));
  assert(existsSync(profile.markerPath));

  // A Windows node-readable profile path is not a truthful macOS launch path.
  // Pure target-path helpers are covered above; exercise the complete macOS
  // profile lifecycle only on hosts whose filesystem uses POSIX path syntax.
  if (process.platform !== "win32") {
    const macRunId = "7".repeat(16);
    const macProfilePath = join(temp, `shellx-final-webdriver-${macRunId}`);
    const macProfile = prepareReleaseSurfaceRunProfile({
      platform: "macos-installed",
      runId: macRunId,
      nodePath: macProfilePath,
      launchPath: macProfilePath,
      debugPort: 31_021,
      mcpPort: 31_022,
    });
    assert.equal(macProfile.platform, "macos-installed");
    assert.equal(macProfile.environment.HOME, macProfilePath);
    assert.equal(macProfile.debugTokenLaunchPath, join(macProfilePath, ".shellx", "shellxagent.token"));
    assert(existsSync(macProfile.markerPath));
    if (process.platform === "darwin") {
      const macReceipt = await cleanupReleaseSurfaceRunProfile({
        profile: macProfile,
        evidencePath: join(temp, "cleanup-macos-profile.json"),
      });
      assert.equal(macReceipt.status, "pass");
      assert.equal(macReceipt.profile.removed, true);
    } else {
      rmSync(macProfilePath, { recursive: true, force: true });
    }
    assert.equal(existsSync(macProfilePath), false);
  }

  child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  assert(child.pid && child.pid > 0);
  const childExit = waitForExit(child);
  const receiptPath = join(temp, "cleanup-pass.json");
  const receipt = await cleanupReleaseSurfaceRunProfile({
    profile,
    evidencePath: receiptPath,
    application: {
      processId: child.pid,
      executableNodePath: process.execPath,
      executableLaunchPath: process.execPath,
    },
    shutdownTimeoutMs: 2_000,
  });
  await childExit;
  child = null;
  assert.equal(receipt.status, "pass");
  assert.equal(receipt.application.alreadyStopped, false);
  assert.equal(receipt.application.identityVerifiedBeforeStop, true);
  assert.equal(
    receipt.application.forcedStop,
    process.platform === "win32",
    "Windows uses identity-bound Stop-Process -Force while POSIX first attempts graceful termination",
  );
  assert.equal(receipt.application.processCountAfter, 0);
  assert.deepEqual(receipt.listeners, { debugCountAfter: 0, mcpCountAfter: 0 });
  assert.deepEqual(receipt.profile, { markerVerified: true, removed: true });
  assert.equal(existsSync(profilePath), false);
  assert.deepEqual(JSON.parse(readFileSync(receiptPath, "utf8")), receipt);
  assert.equal(JSON.stringify(receipt).includes(profilePath), false, "cleanup evidence stores only the profile-path digest");

  const absentRunId = "b".repeat(16);
  const absentPath = join(temp, `shellx-final-webdriver-${absentRunId}`);
  const absentProfile = prepareReleaseSurfaceRunProfile({
    platform: hostPlatform,
    runId: absentRunId,
    nodePath: absentPath,
    launchPath: absentPath,
    debugPort: 31_003,
    mcpPort: 31_004,
  });
  const absentReceipt = await cleanupReleaseSurfaceRunProfile({
    profile: absentProfile,
    evidencePath: join(temp, "cleanup-no-process.json"),
  });
  assert.equal(absentReceipt.application.alreadyStopped, true);
  assert.equal(absentReceipt.application.identityVerifiedBeforeStop, false);
  assert.equal(absentReceipt.application.forcedStop, false);
  assert.deepEqual(absentReceipt.listeners, { debugCountAfter: 0, mcpCountAfter: 0 });
  assert.equal(absentReceipt.profile.removed, true);

  const stoppedRunId = "9".repeat(16);
  const stoppedPath = join(temp, `shellx-final-webdriver-${stoppedRunId}`);
  const stoppedProfile = prepareReleaseSurfaceRunProfile({
    platform: hostPlatform,
    runId: stoppedRunId,
    nodePath: stoppedPath,
    launchPath: stoppedPath,
    debugPort: 31_011,
    mcpPort: 31_012,
  });
  const stoppedChild = spawn(process.execPath, ["-e", "void 0"], { stdio: "ignore" });
  assert(stoppedChild.pid && stoppedChild.pid > 0);
  const stoppedProcessId = stoppedChild.pid;
  await waitForExit(stoppedChild);
  const stoppedReceipt = await cleanupReleaseSurfaceRunProfile({
    profile: stoppedProfile,
    evidencePath: join(temp, "cleanup-stopped-process.json"),
    application: {
      processId: stoppedProcessId,
      executableNodePath: process.execPath,
      executableLaunchPath: process.execPath,
    },
  });
  assert.equal(stoppedReceipt.status, "pass");
  assert.equal(stoppedReceipt.application.alreadyStopped, true);
  assert.equal(stoppedReceipt.application.identityVerifiedBeforeStop, false);
  assert.equal(stoppedReceipt.profile.removed, true);

  const delayedListenerRunId = "8".repeat(16);
  const delayedListenerPath = join(temp, `shellx-final-webdriver-${delayedListenerRunId}`);
  const delayedListenerProfile = prepareReleaseSurfaceRunProfile({
    platform: hostPlatform,
    runId: delayedListenerRunId,
    nodePath: delayedListenerPath,
    launchPath: delayedListenerPath,
    debugPort: 31_013,
    mcpPort: 31_014,
  });
  const delayedListener = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    delayedListener.once("error", rejectListen);
    delayedListener.listen(delayedListenerProfile.debugPort, "127.0.0.1", resolveListen);
  });
  setTimeout(() => delayedListener.close(), 150);
  const delayedListenerReceipt = await cleanupReleaseSurfaceRunProfile({
    profile: delayedListenerProfile,
    evidencePath: join(temp, "cleanup-delayed-listener.json"),
    shutdownTimeoutMs: 2_000,
  });
  assert.equal(delayedListenerReceipt.status, "pass");
  assert.deepEqual(delayedListenerReceipt.listeners, { debugCountAfter: 0, mcpCountAfter: 0 });
  assert.equal(delayedListenerReceipt.profile.removed, true);

  const occupiedRunId = "c".repeat(16);
  const occupiedPath = join(temp, `shellx-final-webdriver-${occupiedRunId}`);
  const occupiedProfile = prepareReleaseSurfaceRunProfile({
    platform: hostPlatform,
    runId: occupiedRunId,
    nodePath: occupiedPath,
    launchPath: occupiedPath,
    debugPort: 31_005,
    mcpPort: 31_006,
  });
  const occupiedEvidence = join(temp, "occupied.json");
  writeFileSync(occupiedEvidence, "occupied", "utf8");
  await assert.rejects(
    cleanupReleaseSurfaceRunProfile({ profile: occupiedProfile, evidencePath: occupiedEvidence }),
    /evidence already exists/,
  );
  assert(existsSync(occupiedPath), "create-only evidence must be reserved before destructive cleanup");

  const tamperedRunId = "d".repeat(16);
  const tamperedPath = join(temp, `shellx-final-webdriver-${tamperedRunId}`);
  const tamperedProfile = prepareReleaseSurfaceRunProfile({
    platform: hostPlatform,
    runId: tamperedRunId,
    nodePath: tamperedPath,
    launchPath: tamperedPath,
    debugPort: 31_007,
    mcpPort: 31_008,
  });
  const marker = JSON.parse(readFileSync(tamperedProfile.markerPath, "utf8"));
  marker.runId = "e".repeat(16);
  writeFileSync(tamperedProfile.markerPath, `${JSON.stringify(marker)}\n`, "utf8");
  let tamperError: ReleaseSurfaceRunProfileCleanupError | null = null;
  try {
    await cleanupReleaseSurfaceRunProfile({
      profile: tamperedProfile,
      evidencePath: join(temp, "cleanup-tampered.json"),
    });
  } catch (error) {
    assert(error instanceof ReleaseSurfaceRunProfileCleanupError);
    tamperError = error;
  }
  assert(tamperError);
  assert.equal(tamperError.receipt.status, "failed");
  assert.deepEqual(tamperError.receipt.profile, { markerVerified: false, removed: false });
  assert(existsSync(tamperedPath), "marker drift must preserve the profile for diagnosis");

  assert.throws(() => prepareReleaseSurfaceRunProfile({
    platform: hostPlatform,
    runId: "f".repeat(16),
    nodePath: join(temp, "wrong-name"),
    launchPath: join(temp, "wrong-name"),
    debugPort: 31_009,
    mcpPort: 31_010,
  }), /exact shellx-final-webdriver/);

  console.log("Release surface run-profile cleanup tests passed");
} finally {
  if (child?.pid) child.kill("SIGKILL");
  rmSync(temp, { recursive: true, force: true });
}

async function waitForExit(processHandle: ChildProcess): Promise<void> {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) return;
  await new Promise<void>((resolveExit, reject) => {
    // Windows hosted runners can deliver the ChildProcess exit event several
    // seconds after the identity-bound Stop-Process call and the native
    // process-count verification have already completed. Keep waiting for the
    // real event; never infer exit from the cleanup receipt alone.
    const timeoutMs = process.platform === "win32" ? 15_000 : 5_000;
    const timeout = setTimeout(
      () => reject(new Error(`owned fixture process did not exit within ${timeoutMs}ms`)),
      timeoutMs,
    );
    processHandle.once("exit", () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
}
