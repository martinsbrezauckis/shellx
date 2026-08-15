import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  collectReleaseSurfaceInstalledPayloadManifest,
  collectReleaseSurfaceInstalledPayloadManifestForPlatform,
  isReleaseSurfacePathInsideRoot,
  releaseSurfaceInstalledPayloadManifestDigest,
  sameReleaseSurfaceInstalledPayloadManifest,
  validateReleaseSurfaceInstalledPayloadManifest,
  type ReleaseSurfaceInstalledPayloadManifest,
} from "./lib/release-surface-installed-payload-manifest";
import {
  RELEASE_SURFACE_INSTALLATION_RECEIPT_SCHEMA,
  validateReleaseSurfaceInstallationReceipt,
  type ReleaseSurfaceInstallationReceipt,
} from "./lib/release-surface-installation-receipt";
import { releaseSourceOnlyRequested } from "./lib/release-source-test-mode";

const temp = mkdtempSync(join(tmpdir(), "shellx-installed-manifest-"));
try {
  const recordedFixtureRoot = "/tmp/shellx-installed-manifest-fixture";
  const installerRoot = join(temp, "shellx-final-install-tree");
  const installerRecordedRoot = `${recordedFixtureRoot}/tree`;
  mkdirSync(join(installerRoot, "empty-dir"), { recursive: true });
  mkdirSync(join(installerRoot, "resources"));
  writeFileSync(join(installerRoot, "shellx"), "candidate-bytes", "utf8");
  writeFileSync(join(installerRoot, "resources", "empty.dat"), "", "utf8");
  writeFileSync(join(installerRoot, "resources", "ž-漢.txt"), "unicode", "utf8");
  const first = collectReleaseSurfaceInstalledPayloadManifest({
    nodeRootPath: installerRoot,
    recordedRootPath: installerRecordedRoot,
    platform: "linux-installed",
    scope: "installer-target-root",
    mainExecutableRelativePath: "shellx",
    collectedAt: "2026-07-28T17:58:51.000Z",
  });
  const second = collectReleaseSurfaceInstalledPayloadManifest({
    nodeRootPath: installerRoot,
    recordedRootPath: installerRecordedRoot,
    platform: "linux-installed",
    scope: "installer-target-root",
    mainExecutableRelativePath: "shellx",
    collectedAt: "2026-07-28T17:58:52.000Z",
  });
  assert.deepEqual(validateReleaseSurfaceInstalledPayloadManifest(first), []);
  assert(sameReleaseSurfaceInstalledPayloadManifest(first, second));
  assert(first.entries.some((entry) => entry.path === "empty-dir" && entry.kind === "directory"));
  assert(first.entries.some((entry) => entry.path === "resources/empty.dat" && entry.kind === "file" && entry.bytes === 0));
  assert(first.entries.some((entry) => entry.path === "resources/ž-漢.txt"));

  writeFileSync(join(installerRoot, "resources", "ž-漢.txt"), "mutated", "utf8");
  const mutated = collectReleaseSurfaceInstalledPayloadManifest({
    nodeRootPath: installerRoot,
    recordedRootPath: installerRecordedRoot,
    platform: "linux-installed",
    scope: "installer-target-root",
    mainExecutableRelativePath: "shellx",
  });
  assert(!sameReleaseSurfaceInstalledPayloadManifest(first, mutated), "payload byte mutation must change the manifest identity");

  const linkedRoot = join(temp, "shellx-final-install-linked");
  const linkedRecordedRoot = `${recordedFixtureRoot}/linked`;
  mkdirSync(linkedRoot);
  writeFileSync(join(linkedRoot, "shellx"), "candidate-bytes", "utf8");
  if (process.platform === "win32") {
    const linkedDirectory = join(linkedRoot, "resources");
    mkdirSync(linkedDirectory);
    symlinkSync(linkedDirectory, join(linkedRoot, "alias"), "junction");
  } else {
    symlinkSync(join(linkedRoot, "shellx"), join(linkedRoot, "alias"));
  }
  assert.throws(() => collectReleaseSurfaceInstalledPayloadManifest({
    nodeRootPath: linkedRoot,
    recordedRootPath: linkedRecordedRoot,
    platform: "linux-installed",
    scope: "installer-target-root",
    mainExecutableRelativePath: "shellx",
  }), /refuses link or reparse entry/, "link-bearing installed roots must fail closed");

  const directRoot = join(temp, "shellx-final-install-direct");
  const directRecordedRoot = `${recordedFixtureRoot}/direct`;
  mkdirSync(directRoot);
  writeFileSync(join(directRoot, "shellx"), "candidate-bytes", "utf8");
  const direct = collectReleaseSurfaceInstalledPayloadManifest({
    nodeRootPath: directRoot,
    recordedRootPath: directRecordedRoot,
    platform: "linux-installed",
    scope: "staged-direct-file",
    mainExecutableRelativePath: "shellx",
    collectedAt: "2026-07-28T17:58:52.000Z",
  });
  assert.deepEqual(validateReleaseSurfaceInstalledPayloadManifest(direct), []);
  assert(isReleaseSurfacePathInsideRoot("/mnt/c/Temp/ShellX", "/mnt/c/temp/shellx/evidence", "windows-installed"));
  assert(!isReleaseSurfacePathInsideRoot("/mnt/c/Temp/ShellX", "/mnt/c/temp/shellx-other/evidence", "windows-installed"));
  assert(isReleaseSurfacePathInsideRoot(directRoot, join(directRoot, "evidence"), "linux-installed"));

  const traversal = structuredClone(direct);
  traversal.mainExecutableRelativePath = "../shellx";
  traversal.entries[0]!.path = "../shellx";
  refreshDigest(traversal);
  assert(validateReleaseSurfaceInstalledPayloadManifest(traversal).some((error) => error.includes("escapes its root")));

  const collision = structuredClone(direct);
  collision.platform = "windows-installed";
  collision.scope = "installer-target-root";
  collision.mainExecutableRelativePath = "ShellX.exe";
  collision.entries = [
    { path: "ShellX.exe", kind: "file", sha256: "a".repeat(64), bytes: 1 },
    { path: "shellx.exe", kind: "file", sha256: "b".repeat(64), bytes: 1 },
  ];
  collision.entryCount = 2;
  collision.totalFileBytes = 2;
  refreshDigest(collision);
  assert(validateReleaseSurfaceInstalledPayloadManifest(collision).some((error) => error.includes("Windows case collision")));

  const oldSchema = structuredClone(direct) as unknown as { schema: string };
  oldSchema.schema = "shellx/release-surface-installed-payload-manifest@0";
  assert(validateReleaseSurfaceInstalledPayloadManifest(oldSchema as ReleaseSurfaceInstalledPayloadManifest)
    .some((error) => error.includes("schema")));
  assert.deepEqual(validateReleaseSurfaceInstalledPayloadManifest(undefined), ["installed payload manifest is required"]);

  const main = direct.entries[0]!;
  assert.equal(main.kind, "file");
  if (main.kind !== "file") throw new Error("direct manifest fixture main entry must be a file");
  const receipt: ReleaseSurfaceInstallationReceipt = {
    schema: RELEASE_SURFACE_INSTALLATION_RECEIPT_SCHEMA,
    platform: "linux-installed",
    sourceCommit: "b".repeat(40),
    version: "0.3.5",
    createdAt: "2026-07-28T17:59:00.000Z",
    method: "direct-artifact",
    status: "pass",
    distributionArtifact: { basename: "ShellX", sha256: main.sha256, bytes: main.bytes },
    installedPayload: { basename: "shellx", sha256: main.sha256, bytes: main.bytes, path: `${directRecordedRoot}/shellx` },
    coverage: { payload: "staged-direct-file", systemEffects: "not-observed" },
    systemEffects: [],
    operation: {
      adapter: "linux-direct-stage-v1",
      orchestrator: "native",
      startedAt: "2026-07-28T17:58:30.000Z",
      completedAt: "2026-07-28T17:58:50.000Z",
      targetRootStateBefore: "absent",
    },
    payloadManifest: direct,
    manifestVerification: {
      firstCollectedAt: "2026-07-28T17:58:51.000Z",
      secondCollectedAt: direct.collectedAt,
      firstManifestSha256: direct.manifestSha256,
      secondManifestSha256: direct.manifestSha256,
    },
    checks: ["target-absent", "payload-staged", "payload-hash-recomputed", "manifest-double-collected"].map((id) => ({
      id,
      status: "pass",
      observed: `${id} observed`,
    })),
  };
  assert.deepEqual(validateReleaseSurfaceInstallationReceipt({
    receipt,
    platform: receipt.platform,
    sourceCommit: receipt.sourceCommit,
    version: receipt.version,
    method: receipt.method,
    artifact: receipt.distributionArtifact,
    installedPayload: receipt.installedPayload,
  }), []);
  const wrongAdapter = structuredClone(receipt);
  wrongAdapter.operation.adapter = "windows-direct-stage-v1";
  assert(validateReleaseSurfaceInstallationReceipt({
    receipt: wrongAdapter,
    platform: receipt.platform,
    sourceCommit: receipt.sourceCommit,
    version: receipt.version,
    method: receipt.method,
    artifact: receipt.distributionArtifact,
    installedPayload: receipt.installedPayload,
  }).some((error) => error.includes("installation adapter")));
  const changedSourceArtifact = structuredClone(receipt);
  changedSourceArtifact.distributionArtifact.sha256 = "f".repeat(64);
  assert(validateReleaseSurfaceInstallationReceipt({
    receipt: changedSourceArtifact,
    platform: receipt.platform,
    sourceCommit: receipt.sourceCommit,
    version: receipt.version,
    method: receipt.method,
    artifact: changedSourceArtifact.distributionArtifact,
    installedPayload: receipt.installedPayload,
  }).some((error) => error.includes("must match the distribution artifact bytes")));
  const unsupportedSystemEffects = structuredClone(receipt) as unknown as {
    coverage: { payload: "staged-direct-file"; systemEffects: string };
  };
  unsupportedSystemEffects.coverage.systemEffects = "declared-subset";
  assert(validateReleaseSurfaceInstallationReceipt({
    receipt: unsupportedSystemEffects as ReleaseSurfaceInstallationReceipt,
    platform: receipt.platform,
    sourceCommit: receipt.sourceCommit,
    version: receipt.version,
    method: receipt.method,
    artifact: receipt.distributionArtifact,
    installedPayload: receipt.installedPayload,
  }).some((error) => error.includes("system-effect coverage must be not-observed")));
  const mismatchedSnapshots = structuredClone(receipt);
  mismatchedSnapshots.manifestVerification.firstManifestSha256 = "f".repeat(64);
  assert(validateReleaseSurfaceInstallationReceipt({
    receipt: mismatchedSnapshots,
    platform: receipt.platform,
    sourceCommit: receipt.sourceCommit,
    version: receipt.version,
    method: receipt.method,
    artifact: receipt.distributionArtifact,
    installedPayload: receipt.installedPayload,
  }).some((error) => error.includes("double collection")));
  const wrongPersistedSnapshot = structuredClone(receipt);
  wrongPersistedSnapshot.manifestVerification.secondCollectedAt = "2026-07-28T17:58:53.000Z";
  assert(validateReleaseSurfaceInstallationReceipt({
    receipt: wrongPersistedSnapshot,
    platform: receipt.platform,
    sourceCommit: receipt.sourceCommit,
    version: receipt.version,
    method: receipt.method,
    artifact: receipt.distributionArtifact,
    installedPayload: receipt.installedPayload,
  }).some((error) => error.includes("second collected snapshot")));
  const impossibleOrchestrator = structuredClone(receipt);
  impossibleOrchestrator.operation.orchestrator = "wsl";
  assert(validateReleaseSurfaceInstallationReceipt({
    receipt: impossibleOrchestrator,
    platform: receipt.platform,
    sourceCommit: receipt.sourceCommit,
    version: receipt.version,
    method: receipt.method,
    artifact: receipt.distributionArtifact,
    installedPayload: receipt.installedPayload,
  }).some((error) => error.includes("only for a Windows")));
} finally {
  rmSync(temp, { recursive: true });
}

if (!releaseSourceOnlyRequested() && (process.platform === "win32" || process.env.WSL_INTEROP?.trim())) {
  testWindowsNativeCollector();
} else if (releaseSourceOnlyRequested()) {
  console.log("SKIP Windows native installed-payload collector: source-only pre-push qualification requested");
} else {
  console.log("SKIP Windows native installed-payload collector: native Windows or WSL interop is required");
}

const windowsPayloadSource = readFileSync(
  resolve(import.meta.dirname, "collect-release-surface-windows-payload.ps1"),
  "utf8",
);
assert(windowsPayloadSource.includes("[IO.DriveInfo]::new"));
assert(windowsPayloadSource.includes("subst.exe"));
assert(!windowsPayloadSource.includes("Get-CimInstance"));

console.log("Release surface installed payload manifest tests passed");

function refreshDigest(manifest: ReleaseSurfaceInstalledPayloadManifest): void {
  manifest.manifestSha256 = releaseSurfaceInstalledPayloadManifestDigest(manifest);
}

function testWindowsNativeCollector(): void {
  const windowsTemp = runPowerShell("[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); [IO.Path]::GetTempPath()");
  const nodeTemp = process.platform === "win32" ? windowsTemp : runWslpath("-u", windowsTemp);
  const nodeRoot = mkdtempSync(join(nodeTemp, "shellx-final-install-native-"));
  const windowsRoot = process.platform === "win32" ? nodeRoot : runWslpath("-w", nodeRoot);
  const junctionWindowsPath = `${windowsRoot}\\alias`;
  try {
    writeFileSync(join(nodeRoot, "shellx.exe"), "native-candidate", "utf8");
    const direct = collectReleaseSurfaceInstalledPayloadManifestForPlatform({
      nodeRootPath: nodeRoot,
      recordedRootPath: windowsRoot,
      platform: "windows-installed",
      scope: "staged-direct-file",
      mainExecutableRelativePath: "shellx.exe",
    });
    assert.deepEqual(validateReleaseSurfaceInstalledPayloadManifest(direct), []);
    assert.equal(direct.entries.length, 1);

    mkdirSync(join(nodeRoot, "resources"));
    writeFileSync(join(nodeRoot, "resources", "ž-漢.txt"), "native-unicode", "utf8");
    const first = collectReleaseSurfaceInstalledPayloadManifestForPlatform({
      nodeRootPath: nodeRoot,
      recordedRootPath: windowsRoot,
      platform: "windows-installed",
      scope: "installer-target-root",
      mainExecutableRelativePath: "shellx.exe",
    });
    const second = collectReleaseSurfaceInstalledPayloadManifestForPlatform({
      nodeRootPath: nodeRoot,
      recordedRootPath: windowsRoot,
      platform: "windows-installed",
      scope: "installer-target-root",
      mainExecutableRelativePath: "shellx.exe",
    });
    assert(sameReleaseSurfaceInstalledPayloadManifest(first, second));
    assert(first.entries.some((entry) => entry.path === "resources/ž-漢.txt"));

    const junctionTarget = `${windowsRoot}\\resources`;
    runPowerShell(`New-Item -ItemType Junction -Path '${psSingleQuote(junctionWindowsPath)}' -Target '${psSingleQuote(junctionTarget)}' | Out-Null`);
    assert.throws(() => collectReleaseSurfaceInstalledPayloadManifestForPlatform({
      nodeRootPath: nodeRoot,
      recordedRootPath: windowsRoot,
      platform: "windows-installed",
      scope: "installer-target-root",
      mainExecutableRelativePath: "shellx.exe",
    }), /link or reparse entry/, "native Windows collection must reject junctions before traversal");
    removeWindowsJunction(junctionWindowsPath);
  } finally {
    const cleanup = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      `if (Test-Path -LiteralPath '${psSingleQuote(junctionWindowsPath)}') { & cmd.exe /d /c rmdir '${psSingleQuote(junctionWindowsPath)}'; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }`,
    ], { encoding: "utf8" });
    assert.equal(cleanup.status, 0, cleanup.stderr || cleanup.stdout);
    rmSync(nodeRoot, { recursive: true });
  }
}

function runPowerShell(command: string): string {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim().replace(/\r/g, "");
}

function runWslpath(mode: "-u" | "-w", path: string): string {
  const result = spawnSync("wslpath", [mode, path], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function psSingleQuote(value: string): string {
  return value.replaceAll("'", "''");
}

function removeWindowsJunction(path: string): void {
  runPowerShell(`& cmd.exe /d /c rmdir '${psSingleQuote(path)}'; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`);
}
