import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  RELEASE_SURFACE_INSTALLATION_RECEIPT_SCHEMA,
  validateReleaseSurfaceInstallationReceipt,
  type ReleaseSurfaceInstallationReceipt,
} from "./lib/release-surface-installation-receipt";
import {
  collectReleaseSurfaceInstalledPayloadManifest,
  type ReleaseSurfaceInstalledPayloadManifest,
} from "./lib/release-surface-installed-payload-manifest";
import {
  RELEASE_SURFACE_MACOS_DMG_INSTALLATION_SCHEMA,
  releaseSurfaceMacosPayloadTreeDigest,
  removeReleaseSurfaceMacosManifestBoundTree,
  validateReleaseSurfaceMacosDmgInstallationObservation,
  type ReleaseSurfaceMacosDmgInstallationObservation,
} from "./lib/release-surface-macos-dmg-installation";
import {
  assertReleaseSurfacePathInsidePrivateRoot,
  parseReleaseSurfaceCodesignDisplay,
  parseReleaseSurfaceGatekeeperAssessment,
  parseReleaseSurfaceHdiutilAttachJson,
} from "./lib/release-surface-macos-native";
import {
  RELEASE_SURFACE_MACOS_DEVELOPER_ID_AUTHORITY,
  type ReleaseSurfaceNativeSignatureVerification,
} from "./lib/release-surface-signature-receipt";

const mounted = parseReleaseSurfaceHdiutilAttachJson({
  "system-entities": [
    { "dev-entry": "/dev/disk7" },
    {
      "dev-entry": "/dev/disk7s1",
      "mount-point": "/private/tmp/shellx-final-install-image-fixture/shellX",
      "volume-name": "shellX",
    },
  ],
});
assert.equal(mounted.deviceEntry, "/dev/disk7s1");
assert.equal(mounted.volumeName, "shellX");
assert.throws(() => parseReleaseSurfaceHdiutilAttachJson({
  "system-entities": [
    { "dev-entry": "/dev/disk7s1", "mount-point": "/Volumes/One" },
    { "dev-entry": "/dev/disk7s2", "mount-point": "/Volumes/Two" },
  ],
}), /exactly one mounted filesystem/);
assert.throws(() => parseReleaseSurfaceHdiutilAttachJson({
  "system-entities": [{ "dev-entry": "/dev/not-a-disk", "mount-point": "/Volumes/ShellX" }],
}), /invalid device entry/);

const codesign = parseReleaseSurfaceCodesignDisplay([
  "Executable=/Volumes/shellX/shellX.app/Contents/MacOS/shellX",
  "Identifier=lv.shellx.app",
  "Authority=Developer ID Application: Martins Brezauckis (4M329JW6R4)",
  "Authority=Developer ID Certification Authority",
  "Authority=Apple Root CA",
  "Timestamp=30 Jul 2026 at 12:00:00",
  "TeamIdentifier=4M329JW6R4",
  "CodeDirectory v=20500 size=52933 flags=0x10000(runtime) hashes=1642+7 location=embedded",
].join("\n"));
assert.equal(codesign.identifier, "lv.shellx.app");
assert.equal(codesign.teamIdentifier, "4M329JW6R4");
assert.equal(codesign.secureTimestamp, true);
assert.equal(codesign.hardenedRuntime, true);
assert.deepEqual(parseReleaseSurfaceGatekeeperAssessment([
  "/Volumes/shellX/shellX.app: accepted",
  "source=Notarized Developer ID",
].join("\n")), { status: "accepted", assessmentType: "execute", source: "Notarized Developer ID" });
assert.throws(() => parseReleaseSurfaceGatekeeperAssessment("shellX.app: accepted\nsource=Developer ID"), /Notarized/);

if (process.platform === "win32") {
  console.log("SKIP macOS DMG filesystem fixture: requires POSIX application-bundle path semantics");
  process.exit(0);
}

const temp = mkdtempSync(join(tmpdir(), "shellx-macos-dmg-fixture-"));
try {
  const physicalMountRoot = join(temp, "private-var-mount-root");
  const reportedMountPoint = join(physicalMountRoot, "shellX");
  const aliasedMountRoot = join(temp, "var-mount-root");
  mkdirSync(reportedMountPoint, { recursive: true });
  symlinkSync(physicalMountRoot, aliasedMountRoot, "dir");
  assert.doesNotThrow(() => assertReleaseSurfacePathInsidePrivateRoot(
    aliasedMountRoot,
    reportedMountPoint,
    "aliased hdiutil mount point",
  ), "private mount containment must compare real filesystem paths across /var and /private/var aliases");
  assert.throws(() => assertReleaseSurfacePathInsidePrivateRoot(
    aliasedMountRoot,
    temp,
    "outside hdiutil mount point",
  ), /must be a child/);

  const targetApp = join(temp, "shellx-final-install-fixture.app");
  createFixtureApplication(targetApp);
  const targetManifest = collectManifest(targetApp, "2026-07-30T12:00:04.000Z");
  const artifact = { basename: "shellX_0.3.5_aarch64.dmg", sha256: "a".repeat(64), bytes: 987_654 };
  const executable = targetManifest.entries.find((entry) => entry.path === "Contents/MacOS/shellX");
  assert(executable?.kind === "file");
  const signature = macosSignature(artifact, {
    basename: "shellX",
    sha256: executable.sha256,
    bytes: executable.bytes,
  });
  const systemEffects = [
    {
      id: "macos-app-bundle-copy",
      status: "pass" as const,
      observed: "fixture copy",
      details: { sourceApp: "shellX.app", targetApp, copyTool: "/usr/bin/ditto", overwriteAllowed: false },
    },
    {
      id: "macos-disk-image-lifecycle",
      status: "pass" as const,
      observed: "fixture mount lifecycle",
      details: { deviceEntry: "/dev/disk7s1", readOnly: true, detached: true },
    },
    {
      id: "macos-autolaunch-suppressed",
      status: "pass" as const,
      observed: "fixture process baseline",
      details: { launchRequested: false, processesBefore: 0, processesAfter: 0 },
    },
  ];
  const treeSha256 = releaseSurfaceMacosPayloadTreeDigest(targetManifest);
  const observation: ReleaseSurfaceMacosDmgInstallationObservation = {
    schema: RELEASE_SURFACE_MACOS_DMG_INSTALLATION_SCHEMA,
    collector: "macos-native-dmg-install-v1",
    artifact: { ...artifact, path: "/Users/fixture/Release/shellX_0.3.5_aarch64.dmg" },
    operation: {
      startedAt: "2026-07-30T12:00:00.000Z",
      completedAt: "2026-07-30T12:00:03.000Z",
      exitCode: 0,
      targetRootStateBefore: "absent",
      arguments: ["attach-readonly-nobrowse-noautoopen", "ditto-copy-without-launch", "detach-exact-device"],
    },
    mountedImage: {
      deviceEntry: "/dev/disk7s1",
      mountPoint: "/private/tmp/shellx-final-install-image-fixture/shellX",
      volumeName: "shellX",
      mountedAt: "2026-07-30T12:00:00.500Z",
      detachedAt: "2026-07-30T12:00:03.000Z",
      readOnly: true,
      noBrowse: true,
      noAutoOpen: true,
      detached: true,
      sourceApplicationRelativePath: "shellX.app",
    },
    sourceApplication: {
      executableRelativePath: "shellX.app/Contents/MacOS/shellX",
      executable: signature.application.executable,
      payloadTreeSha256: treeSha256,
      entryCount: targetManifest.entryCount,
      totalFileBytes: targetManifest.totalFileBytes,
    },
    targetApplication: {
      path: targetApp,
      stateBefore: "absent",
      createdWithoutOverwrite: true,
      ownerUid: 501,
      executableRelativePath: "Contents/MacOS/shellX",
      executable: signature.application.executable,
      payloadTreeSha256: treeSha256,
      entryCount: targetManifest.entryCount,
      totalFileBytes: targetManifest.totalFileBytes,
      codesignVerified: true,
      gatekeeperAccepted: true,
    },
    safety: { shellxProcessIdsBefore: [], shellxProcessIdsAfter: [], launchRequested: false },
    systemEffects,
  };
  const validateObservation = (candidate: ReleaseSurfaceMacosDmgInstallationObservation) =>
    validateReleaseSurfaceMacosDmgInstallationObservation({
      observation: candidate,
      artifact,
      artifactPath: observation.artifact.path,
      targetApp,
      approvedSignature: signature,
      targetManifest,
    });
  assert.deepEqual(validateObservation(observation), []);
  const launched = structuredClone(observation);
  launched.safety.shellxProcessIdsAfter = [42] as unknown as [];
  assert(validateObservation(launched).some((error) => error.includes("no-autolaunch")));
  const attached = structuredClone(observation);
  attached.mountedImage.detached = false as true;
  assert(validateObservation(attached).some((error) => error.includes("exact detach")));
  const partialCopy = structuredClone(observation);
  partialCopy.targetApplication.payloadTreeSha256 = "f".repeat(64);
  assert(validateObservation(partialCopy).some((error) => error.includes("complete installed application manifest")));

  const receipt: ReleaseSurfaceInstallationReceipt = {
    schema: RELEASE_SURFACE_INSTALLATION_RECEIPT_SCHEMA,
    platform: "macos-installed",
    sourceCommit: "b".repeat(40),
    version: "0.3.5",
    createdAt: "2026-07-30T12:00:06.000Z",
    method: "installer-observed",
    status: "pass",
    distributionArtifact: artifact,
    installedPayload: {
      basename: executable.path.split("/").at(-1)!,
      sha256: executable.sha256,
      bytes: executable.bytes,
      path: join(targetApp, "Contents", "MacOS", "shellX"),
    },
    coverage: { payload: "complete-target-root", systemEffects: "declared-subset" },
    systemEffects,
    nativeMacosDmgObservation: observation,
    signatureReceipt: { basename: "macos-signature.json", sha256: "c".repeat(64), bytes: 4096 },
    macosSignatureVerification: signature,
    operation: {
      adapter: "macos-dmg-install-v1",
      orchestrator: "native",
      startedAt: observation.operation.startedAt,
      completedAt: observation.operation.completedAt,
      targetRootStateBefore: "absent",
      exitCode: 0,
    },
    payloadManifest: targetManifest,
    manifestVerification: {
      firstCollectedAt: "2026-07-30T12:00:03.500Z",
      secondCollectedAt: targetManifest.collectedAt,
      firstManifestSha256: targetManifest.manifestSha256,
      secondManifestSha256: targetManifest.manifestSha256,
    },
    checks: [
      "artifact-signature-valid", "artifact-unchanged", "target-absent", "image-mounted-readonly",
      "app-copied-without-overwrite", "payload-hash-recomputed", "manifest-double-collected",
      "system-effects-observed", "process-autolaunch-absent", "image-detached",
    ].map((id) => ({ id, status: "pass", observed: `${id} observed` })),
  };
  const validateReceipt = (candidate: ReleaseSurfaceInstallationReceipt) => validateReleaseSurfaceInstallationReceipt({
    receipt: candidate,
    platform: "macos-installed",
    sourceCommit: receipt.sourceCommit,
    version: receipt.version,
    method: "installer-observed",
    artifact,
    installedPayload: receipt.installedPayload,
  });
  assert.deepEqual(validateReceipt(receipt), []);
  const missingSignature = structuredClone(receipt);
  delete missingSignature.macosSignatureVerification;
  assert(validateReceipt(missingSignature).some((error) => error.includes("Developer ID")));
  const unboundEffects = structuredClone(receipt);
  unboundEffects.systemEffects[0]!.details.targetApp = "/Applications/Other.app";
  assert(validateReceipt(unboundEffects).some((error) => error.includes("copy effect")));

  const removable = join(temp, "shellx-final-install-removable.app");
  createFixtureApplication(removable);
  const removableManifest = collectManifest(removable, "2026-07-30T12:00:07.000Z");
  writeFileSync(join(removable, "Contents", "Resources", "readme.txt"), "changed", "utf8");
  assert.throws(() => removeReleaseSurfaceMacosManifestBoundTree({ targetApp: removable, manifest: removableManifest }), /(?:identity|hash) changed/);
  assert(existsSync(removable), "changed target must be preserved for investigation");
  rmSync(removable, { recursive: true });
  createFixtureApplication(removable);
  const exactManifest = collectManifest(removable, "2026-07-30T12:00:08.000Z");
  removeReleaseSurfaceMacosManifestBoundTree({ targetApp: removable, manifest: exactManifest });
  assert(!existsSync(removable), "exact manifest-bound finalization must remove only the bound app tree");

  const creatorSource = readFileSync(resolve(import.meta.dirname, "create-release-surface-macos-dmg-installation-receipt.ts"), "utf8");
  assert(!creatorSource.includes('run("/usr/bin/open"'), "DMG installation adapter must never request application launch");
  assert(creatorSource.includes("assertReleaseSurfacePathInsidePrivateRoot(mountRoot, mounted.mountPoint"),
    "DMG installation adapter must canonicalize /var and /private/var before containment checks");
  const finalizerSource = readFileSync(resolve(import.meta.dirname, "finalize-release-surface-macos-dmg-installation.ts"), "utf8");
  assert(!finalizerSource.includes("recursive: true"), "native finalizer must use exact manifest-bound deletion");
} finally {
  rmSync(temp, { recursive: true });
}

console.log("Release surface macOS DMG installation fixture and parser tests passed");

function createFixtureApplication(root: string): void {
  mkdirSync(join(root, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(root, "Contents", "Resources"));
  writeFileSync(join(root, "Contents", "MacOS", "shellX"), "fixture-executable", "utf8");
  writeFileSync(join(root, "Contents", "Resources", "readme.txt"), "fixture-resource", "utf8");
}

function collectManifest(root: string, collectedAt: string): ReleaseSurfaceInstalledPayloadManifest {
  return collectReleaseSurfaceInstalledPayloadManifest({
    nodeRootPath: root,
    recordedRootPath: root,
    platform: "macos-installed",
    scope: "installer-target-root",
    mainExecutableRelativePath: "Contents/MacOS/shellX",
    collectedAt,
  });
}

function macosSignature(
  artifact: { basename: string; sha256: string; bytes: number },
  executable: { basename: string; sha256: string; bytes: number },
): Extract<ReleaseSurfaceNativeSignatureVerification, { kind: "macos-codesign" }> {
  return {
    kind: "macos-codesign",
    collector: "macos-native-signature-v1",
    verifiedAt: "2026-07-30T11:59:59.000Z",
    artifact,
    mountedImage: {
      deviceEntry: "/dev/disk6s1",
      mountPoint: "/private/tmp/shellx-final-signature-fixture/shellX",
      volumeName: "shellX",
      mountedAt: "2026-07-30T11:59:55.000Z",
      detachedAt: "2026-07-30T11:59:59.000Z",
      readOnly: true,
      noBrowse: true,
      noAutoOpen: true,
      detached: true,
    },
    application: {
      relativePath: "shellX.app",
      bundleId: "lv.shellx.app",
      teamId: "4M329JW6R4",
      executableRelativePath: "shellX.app/Contents/MacOS/shellX",
      executable,
      authorities: [RELEASE_SURFACE_MACOS_DEVELOPER_ID_AUTHORITY, "Developer ID Certification Authority", "Apple Root CA"],
      designatedRequirement: 'designated => identifier "lv.shellx.app" and anchor apple generic and certificate leaf[subject.OU] = "4M329JW6R4"',
      secureTimestamp: true,
      hardenedRuntime: true,
    },
    codesign: { status: "accepted", deep: true, strict: true, allArchitectures: true },
    gatekeeper: { status: "accepted", assessmentType: "execute", source: "Notarized Developer ID" },
    stapler: { application: "validated", diskImage: "validated" },
  };
}
