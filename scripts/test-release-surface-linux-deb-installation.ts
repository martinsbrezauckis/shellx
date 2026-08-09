import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  RELEASE_SURFACE_INSTALLATION_RECEIPT_SCHEMA,
  validateReleaseSurfaceInstallationReceipt,
  type ReleaseSurfaceInstallationReceipt,
} from "./lib/release-surface-installation-receipt";
import {
  collectReleaseSurfaceInstalledPayloadManifest,
  sameReleaseSurfaceInstalledPayloadManifest,
} from "./lib/release-surface-installed-payload-manifest";
import {
  collectReleaseSurfaceLinuxDebInstallation,
  RELEASE_SURFACE_LINUX_DEB_MAIN_EXECUTABLE,
  RELEASE_SURFACE_LINUX_DEB_PACKAGE_NAME,
  removeReleaseSurfaceLinuxManifestTarget,
  validateReleaseSurfaceLinuxDebInstallationObservation,
} from "./lib/release-surface-linux-deb-installation";

if (process.platform !== "linux") {
  console.log("SKIP Linux Debian installation adapter fixture: requires native Linux dpkg-deb and path semantics");
  process.exit(0);
}

const temp = mkdtempSync(join(tmpdir(), "shellx-linux-deb-adapter-test-"));
try {
  const version = "0.3.5";
  const architecture = process.arch === "arm64" ? "arm64" : "amd64";
  const packageRoot = join(temp, "package");
  const controlRoot = join(packageRoot, "DEBIAN");
  const payloadBin = join(packageRoot, "usr", "bin");
  const payloadShare = join(packageRoot, "usr", "share", "shellx");
  mkdirSync(controlRoot, { recursive: true });
  mkdirSync(payloadBin, { recursive: true });
  mkdirSync(payloadShare, { recursive: true });
  writeFileSync(join(controlRoot, "control"), [
    `Package: ${RELEASE_SURFACE_LINUX_DEB_PACKAGE_NAME}`,
    `Version: ${version}`,
    "Section: utils",
    "Priority: optional",
    `Architecture: ${architecture}`,
    "Installed-Size: 2",
    "Maintainer: ShellX fixture <fixture@example.invalid>",
    "Description: ShellX Linux package adapter fixture",
    "",
  ].join("\n"));
  const marker = join(temp, "maintainer-script-executed");
  writeFileSync(join(controlRoot, "postinst"), `#!/bin/sh\nprintf ran > '${marker}'\n`);
  chmodSync(join(controlRoot, "postinst"), 0o755);
  writeFileSync(join(payloadBin, "shellx"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(payloadBin, "shellx"), 0o755);
  writeFileSync(join(payloadShare, "fixture-data.txt"), "receipt-bound fixture\n");
  const artifactPath = join(temp, `shellx_${version}_${architecture}.deb`);
  run("/usr/bin/dpkg-deb", ["--build", packageRoot, artifactPath]);
  const runRoot = join(temp, "shellx-final-linux-run-fixture");
  const targetRoot = join(runRoot, "shellx-final-install-fixture");
  mkdirSync(runRoot, { mode: 0o700 });
  chmodSync(runRoot, 0o700);
  const observation = collectReleaseSurfaceLinuxDebInstallation({ artifactPath, targetRoot, expectedVersion: version });
  const artifact = identify(artifactPath);
  assert.deepEqual(validateReleaseSurfaceLinuxDebInstallationObservation({
    observation,
    artifact,
    artifactPath,
    targetRoot,
    expectedVersion: version,
    allowWslFixture: true,
  }), []);
  assert.equal(readFileSync(join(targetRoot, "usr", "bin", "shellx"), "utf8"), "#!/bin/sh\nexit 0\n");
  assert.throws(() => readFileSync(marker), /ENOENT/, "dpkg-deb extraction must not execute postinst");
  const firstManifest = collectReleaseSurfaceInstalledPayloadManifest({
    nodeRootPath: targetRoot,
    recordedRootPath: targetRoot,
    platform: "linux-installed",
    scope: "installer-target-root",
    mainExecutableRelativePath: RELEASE_SURFACE_LINUX_DEB_MAIN_EXECUTABLE,
  });
  const secondManifest = collectReleaseSurfaceInstalledPayloadManifest({
    nodeRootPath: targetRoot,
    recordedRootPath: targetRoot,
    platform: "linux-installed",
    scope: "installer-target-root",
    mainExecutableRelativePath: RELEASE_SURFACE_LINUX_DEB_MAIN_EXECUTABLE,
  });
  assert.equal(sameReleaseSurfaceInstalledPayloadManifest(firstManifest, secondManifest), true);
  const installedPath = join(targetRoot, "usr", "bin", "shellx");
  const installedPayload = { ...identify(installedPath), path: installedPath };
  const signaturePath = join(temp, "signature-receipt.json");
  writeFileSync(signaturePath, "{\"fixture\":true}\n");
  const nativeObservation = { ...observation, environment: "native-linux" as const };
  const receipt: ReleaseSurfaceInstallationReceipt = {
    schema: RELEASE_SURFACE_INSTALLATION_RECEIPT_SCHEMA,
    platform: "linux-installed",
    sourceCommit: "a".repeat(40),
    version,
    createdAt: new Date(Date.parse(secondManifest.collectedAt) + 1).toISOString(),
    method: "installer-observed",
    status: "pass",
    distributionArtifact: artifact,
    installedPayload,
    coverage: { payload: "complete-target-root", systemEffects: "declared-subset" },
    systemEffects: nativeObservation.systemEffects,
    nativeLinuxDebObservation: nativeObservation,
    signatureReceipt: identify(signaturePath),
    linuxDigestVerification: { kind: "artifact-digest", algorithm: "sha256", sha256: artifact.sha256 },
    operation: {
      adapter: "linux-package-install-v1",
      orchestrator: "native",
      startedAt: nativeObservation.operation.startedAt,
      completedAt: nativeObservation.operation.completedAt,
      targetRootStateBefore: "absent",
      exitCode: 0,
    },
    payloadManifest: secondManifest,
    manifestVerification: {
      firstCollectedAt: firstManifest.collectedAt,
      secondCollectedAt: secondManifest.collectedAt,
      firstManifestSha256: firstManifest.manifestSha256,
      secondManifestSha256: secondManifest.manifestSha256,
    },
    checks: [
      "native-linux-baseline",
      "artifact-digest-valid",
      "artifact-unchanged",
      "target-absent",
      "package-metadata-valid",
      "package-extraction-exit-zero",
      "payload-created",
      "payload-hash-recomputed",
      "manifest-double-collected",
      "system-effects-observed",
      "package-database-unchanged",
      "process-autolaunch-absent",
      "host-integration-unchanged",
    ].map((id) => ({ id, status: "pass" as const, observed: `${id} fixture observation` })),
  };
  const validate = (candidate: ReleaseSurfaceInstallationReceipt) => validateReleaseSurfaceInstallationReceipt({
    receipt: candidate,
    platform: "linux-installed",
    sourceCommit: receipt.sourceCommit,
    version,
    method: "installer-observed",
    artifact,
    installedPayload,
  });
  assert.deepEqual(validate(receipt), []);
  const wslErrors = validateReleaseSurfaceLinuxDebInstallationObservation({
    observation,
    artifact,
    artifactPath,
    targetRoot,
    expectedVersion: version,
  });
  if (observation.environment === "wsl-fixture") assert(wslErrors.some((error) => error.includes("native non-WSL")));
  const missingObservation = structuredClone(receipt);
  delete missingObservation.nativeLinuxDebObservation;
  assert(validate(missingObservation).some((error) => error.includes("structured native Debian observation")));
  const missingSignature = structuredClone(receipt);
  delete missingSignature.signatureReceipt;
  assert(validate(missingSignature).some((error) => error.includes("exact validated signature receipt")));
  const forgedDigest = structuredClone(receipt);
  forgedDigest.linuxDigestVerification!.sha256 = "0".repeat(64);
  assert(validate(forgedDigest).some((error) => error.includes("artifact digest")));
  const forgedDatabase = structuredClone(receipt);
  forgedDatabase.nativeLinuxDebObservation!.safety.after.packageDatabaseSha256 = "0".repeat(64);
  assert(validate(forgedDatabase).some((error) => error.includes("host state changed")));
  const forgedProcess = structuredClone(receipt);
  forgedProcess.nativeLinuxDebObservation!.safety.after.shellxProcessIds = [4242];
  assert(validate(forgedProcess).some((error) => error.includes("must have no ShellX process")));
  const fixturePath = join(targetRoot, "usr", "share", "shellx", "fixture-data.txt");
  const originalFixture = readFileSync(fixturePath);
  writeFileSync(fixturePath, "drift\n");
  assert.throws(
    () => removeReleaseSurfaceLinuxManifestTarget({ targetRoot, manifest: secondManifest }),
    /changed after candidate testing/,
  );
  writeFileSync(fixturePath, originalFixture);
  const removed = removeReleaseSurfaceLinuxManifestTarget({ targetRoot, manifest: secondManifest });
  assert(removed.removedFiles >= 2);
  assert(removed.removedDirectories >= 4);
  const creatorSource = readFileSync(resolve("scripts/create-release-surface-linux-deb-installation-receipt.ts"), "utf8");
  const digestCreatorSource = readFileSync(resolve("scripts/create-release-surface-linux-digest-receipt.ts"), "utf8");
  const finalizerSource = readFileSync(resolve("scripts/finalize-release-surface-linux-deb-installation.ts"), "utf8");
  assert(creatorSource.includes("assertNativeReleaseSurfaceLinuxHost();"));
  assert(creatorSource.includes('flag: "wx"'));
  assert(digestCreatorSource.includes('flag: "wx"'));
  assert(digestCreatorSource.includes("artifact-digest"));
  assert(finalizerSource.includes("assertNativeReleaseSurfaceLinuxHost();"));
  assert(finalizerSource.includes('flag: "wx"'));
  assert.equal(finalizerSource.includes("recursive: true"), false);
  console.log("release-surface Linux Debian installation adapter tests passed");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

function identify(path: string) {
  const bytes = readFileSync(path);
  return { basename: basename(path), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
