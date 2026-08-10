import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  RELEASE_SURFACE_CANDIDATE_ATTESTATION_SCHEMA,
  validateReleaseSurfaceCandidateAttestation,
  type ReleaseSurfaceCandidateAttestation,
  type ReleaseSurfaceFileIdentity,
} from "./lib/release-surface-candidate-attestation";
import {
  RELEASE_SURFACE_INSTALLATION_RECEIPT_SCHEMA,
  validateReleaseSurfaceEvidenceTimeline,
  validateReleaseSurfaceInstallationReceipt,
  type ReleaseSurfaceInstallationReceipt,
} from "./lib/release-surface-installation-receipt";
import { resolveReleaseSurfaceRuntimeCandidate } from "./lib/release-surface-runtime-candidate";
import { releaseSurfacePosixPathDigest } from "./lib/release-surface-posix-native-runtime";
import {
  RELEASE_SURFACE_DRIVER_REQUEST_SCHEMA,
  type ReleaseSurfaceDriverRequest,
} from "./lib/release-surface-driver-protocol";
import {
  RELEASE_SURFACE_INSTALLED_PAYLOAD_MANIFEST_SCHEMA,
  releaseSurfaceInstalledPayloadManifestDigest,
  type ReleaseSurfaceInstalledPayloadManifest,
} from "./lib/release-surface-installed-payload-manifest";
import { syntheticReleaseSurfaceControllerBinding, releaseSurfaceFixtureVersion } from "./fixtures/release-surface-controller-binding-fixture";

const packageVersion = (JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8")) as { version?: string }).version;
assert(typeof packageVersion === "string" && /^\d+\.\d+\.\d+$/.test(packageVersion), "package version must be SemVer");
const appVersion = packageVersion;

const artifact: ReleaseSurfaceFileIdentity = {
  basename: "ShellX.exe",
  sha256: "a".repeat(64),
  bytes: 1024,
};
const installedPayload = {
  basename: "shellx.exe",
  sha256: artifact.sha256,
  bytes: artifact.bytes,
  path: "C:\\Program Files\\ShellX\\shellx.exe",
};
const directReceiptIdentity: ReleaseSurfaceFileIdentity = {
  basename: "installation-direct.json",
  sha256: "c".repeat(64),
  bytes: 512,
};
const directAttestation: ReleaseSurfaceCandidateAttestation = {
  schema: RELEASE_SURFACE_CANDIDATE_ATTESTATION_SCHEMA,
  mode: "final-frozen-candidate",
  platform: "windows-installed",
  sourceCommit: "b".repeat(40),
  version: releaseSurfaceFixtureVersion,
  createdAt: "2026-07-28T18:00:00.000Z",
  distributionArtifact: artifact,
  installation: {
    method: "direct-artifact",
    sourceArtifactSha256: artifact.sha256,
    receipt: directReceiptIdentity,
    payloadManifestSha256: "e".repeat(64),
  },
  installedPayload,
  process: {
    pid: 4321,
    executablePath: "c:/program files/shellx/shellx.exe",
    executableSha256: artifact.sha256,
  },
  runtime: {
    debugBase: "http://127.0.0.1:30123",
    debugPort: 30123,
    debugTokenPath: "C:\\Temp\\shellx-final\\shellxagent.token",
    mcpBase: "http://127.0.0.1:30124",
    mcpPort: 30124,
    mcpTokenPath: "C:\\Temp\\shellx-final\\mcp.token",
    processId: 4321,
    instanceId: "fixture-instance-0001",
    appVersion: releaseSurfaceFixtureVersion,
    buildCommit: "b".repeat(40),
  },
  windowsNativeRuntime: {
    schema: "shellx/release-surface-windows-native-runtime@1",
    collector: "windows-powershell-v1",
    orchestrator: "wsl",
    observedAt: "2026-07-28T17:59:59.000Z",
    osVersion: "Microsoft Windows NT 10.0.26100.0",
    architecture: "x64",
    process: {
      pid: 4321,
      startId: "2026-07-28T17:59:00.000Z",
      imagePath: "C:\\Program Files\\ShellX\\shellx.exe",
      imageSha256: artifact.sha256,
      imageBytes: artifact.bytes,
      imageFileId: "abcd1234:0x00000000000000000000000000000001",
    },
    listener: { address: "127.0.0.1", port: 30123, owningPid: 4321 },
  },
};
assert.deepEqual(validateReleaseSurfaceCandidateAttestation({
  attestation: directAttestation,
  platform: "windows-installed",
  sourceCommit: "b".repeat(40),
  version: releaseSurfaceFixtureVersion,
  artifact,
  installationReceipt: directReceiptIdentity,
}), []);
const wrongPid = structuredClone(directAttestation);
wrongPid.runtime.processId = 9999;
assert(
  validateReleaseSurfaceCandidateAttestation({
    attestation: wrongPid,
    platform: "windows-installed",
    sourceCommit: "b".repeat(40),
    version: releaseSurfaceFixtureVersion,
    artifact,
    installationReceipt: directReceiptIdentity,
  }).some((error) => error.includes("processId")),
  "candidate attestation must reject a runtime outside the OS-owned PID",
);
const missingMcpBinding = structuredClone(directAttestation);
missingMcpBinding.runtime.mcpBase = "";
missingMcpBinding.runtime.mcpTokenPath = "";
missingMcpBinding.runtime.mcpPort = 0;
assert(
  validateReleaseSurfaceCandidateAttestation({
    attestation: missingMcpBinding,
    platform: "windows-installed",
    sourceCommit: "b".repeat(40),
    version: releaseSurfaceFixtureVersion,
    artifact,
    installationReceipt: directReceiptIdentity,
  }).some((error) => error.includes("MCP")),
  "candidate attestation must reject a missing Host MCP endpoint and token binding",
);
const collidingMcpPort = structuredClone(directAttestation);
collidingMcpPort.runtime.mcpBase = collidingMcpPort.runtime.debugBase;
collidingMcpPort.runtime.mcpPort = collidingMcpPort.runtime.debugPort;
assert(
  validateReleaseSurfaceCandidateAttestation({
    attestation: collidingMcpPort,
    platform: "windows-installed",
    sourceCommit: "b".repeat(40),
    version: releaseSurfaceFixtureVersion,
    artifact,
    installationReceipt: directReceiptIdentity,
  }).some((error) => error.includes("distinct")),
  "candidate attestation must reject an MCP endpoint colliding with the Debug API",
);
const missingWindowsNative = structuredClone(directAttestation);
delete missingWindowsNative.windowsNativeRuntime;
assert(
  validateReleaseSurfaceCandidateAttestation({
    attestation: missingWindowsNative,
    platform: "windows-installed",
    sourceCommit: "b".repeat(40),
    version: releaseSurfaceFixtureVersion,
    artifact,
    installationReceipt: directReceiptIdentity,
  }).some((error) => error.includes("native process and listener")),
  "Windows candidate attestation must fail closed without native runtime evidence",
);
const legacySchema = structuredClone(directAttestation) as unknown as { schema: string };
legacySchema.schema = "shellx/release-surface-candidate-attestation@2";
assert(
  validateReleaseSurfaceCandidateAttestation({
    attestation: legacySchema as ReleaseSurfaceCandidateAttestation,
    platform: "windows-installed",
    sourceCommit: "b".repeat(40),
    version: releaseSurfaceFixtureVersion,
    artifact,
    installationReceipt: directReceiptIdentity,
  }).some((error) => error.includes("schema")),
  "legacy candidate attestations must be rejected after native binding became mandatory",
);
const foreignWindowsNative = structuredClone(directAttestation);
foreignWindowsNative.platform = "linux-installed";
assert(
  validateReleaseSurfaceCandidateAttestation({
    attestation: foreignWindowsNative,
    platform: "linux-installed",
    sourceCommit: "b".repeat(40),
    version: releaseSurfaceFixtureVersion,
    artifact,
    installationReceipt: directReceiptIdentity,
  }).some((error) => error.includes("not valid for a non-Windows")),
  "non-Windows candidates must not carry Windows-native evidence",
);
const changedStart = structuredClone(directAttestation);
changedStart.windowsNativeRuntime!.process.startId = "2026-07-28T17:59:30.000Z";
changedStart.windowsNativeRuntime!.process.pid = 9999;
assert(
  validateReleaseSurfaceCandidateAttestation({
    attestation: changedStart,
    platform: "windows-installed",
    sourceCommit: "b".repeat(40),
    version: releaseSurfaceFixtureVersion,
    artifact,
    installationReceipt: directReceiptIdentity,
  }).some((error) => error.includes("Windows candidate runtime")),
  "Windows candidate attestation must reject native process identity drift",
);

const linuxAttestation = structuredClone(directAttestation);
linuxAttestation.platform = "linux-installed";
linuxAttestation.installedPayload.path = "/opt/shellx/shellx";
linuxAttestation.installedPayload.basename = "shellx";
linuxAttestation.process.executablePath = "/opt/shellx/shellx";
linuxAttestation.runtime.debugTokenPath = "/run/user/1000/shellxagent.token";
linuxAttestation.runtime.mcpTokenPath = "/run/user/1000/shellx-mcp.token";
delete linuxAttestation.windowsNativeRuntime;
linuxAttestation.posixNativeRuntime = {
  schema: "shellx/release-surface-posix-native-runtime@1",
  collector: "linux-procfs-v1",
  platform: "linux",
  observedAt: "2026-07-28T17:59:59.000Z",
  osVersion: "6.6.87.2-microsoft-standard-WSL2",
  architecture: "x64",
  process: {
    pid: 4321,
    startId: "linux:12345678-1234-1234-1234-123456789abc:424242",
    imageBasename: "shellx",
    imagePathSha256: releaseSurfacePosixPathDigest(linuxAttestation.process.executablePath),
    imageSha256: artifact.sha256,
    imageBytes: artifact.bytes,
    imageFileId: "8:123456",
  },
  listener: { address: "127.0.0.1", port: 30123, owningPid: 4321, socketId: "inode:987654" },
};
assert.deepEqual(validateReleaseSurfaceCandidateAttestation({
  attestation: linuxAttestation,
  platform: "linux-installed",
  sourceCommit: "b".repeat(40),
  version: releaseSurfaceFixtureVersion,
  artifact,
  installationReceipt: directReceiptIdentity,
}), []);
const missingPosixNative = structuredClone(linuxAttestation);
delete missingPosixNative.posixNativeRuntime;
assert(
  validateReleaseSurfaceCandidateAttestation({
    attestation: missingPosixNative,
    platform: "linux-installed",
    sourceCommit: "b".repeat(40),
    version: releaseSurfaceFixtureVersion,
    artifact,
    installationReceipt: directReceiptIdentity,
  }).some((error) => error.includes("require native process and listener")),
  "Linux candidates must fail closed without native runtime evidence",
);
const replacedPosixImage = structuredClone(linuxAttestation);
replacedPosixImage.posixNativeRuntime!.process.imageFileId = "8:999999";
replacedPosixImage.posixNativeRuntime!.process.imageSha256 = "0".repeat(64);
assert(
  validateReleaseSurfaceCandidateAttestation({
    attestation: replacedPosixImage,
    platform: "linux-installed",
    sourceCommit: "b".repeat(40),
    version: releaseSurfaceFixtureVersion,
    artifact,
    installationReceipt: directReceiptIdentity,
  }).some((error) => error.includes("imageSha256 does not match")),
  "Linux candidates must reject a native executable hash drift",
);

for (const invalidBase of [
  "http://localhost:30123",
  "http://127.0.0.1:30123/health",
  "http://user@127.0.0.1:30123",
  "http://127.0.0.1:30123?candidate=other",
  "https://127.0.0.1:30123",
]) {
  const invalidEndpoint = structuredClone(directAttestation);
  invalidEndpoint.runtime.debugBase = invalidBase;
  assert(
    validateReleaseSurfaceCandidateAttestation({
      attestation: invalidEndpoint,
      platform: "windows-installed",
      sourceCommit: "b".repeat(40),
      version: releaseSurfaceFixtureVersion,
      artifact,
      installationReceipt: directReceiptIdentity,
    }).some((error) => error.includes("exact http://127.0.0.1")),
    `candidate attestation must reject ambiguous debug endpoint ${invalidBase}`,
  );
}

const installedFromInstaller = { ...installedPayload, sha256: "d".repeat(64), bytes: 2048 };
const installerPayloadManifest = payloadManifest({
  platform: "windows-installed",
  scope: "installer-target-root",
  rootPath: "C:\\Program Files\\ShellX",
  mainExecutableRelativePath: "shellx.exe",
  sha256: installedFromInstaller.sha256,
  bytes: installedFromInstaller.bytes,
  collectedAt: "2026-07-28T17:58:52.000Z",
});
installerPayloadManifest.entries.push({ path: "uninstall.exe", kind: "file", sha256: "f".repeat(64), bytes: 512 });
installerPayloadManifest.entries.sort((left, right) => left.path.localeCompare(right.path));
installerPayloadManifest.entryCount = installerPayloadManifest.entries.length;
installerPayloadManifest.totalFileBytes += 512;
installerPayloadManifest.manifestSha256 = releaseSurfaceInstalledPayloadManifestDigest(installerPayloadManifest);
const installerSystemEffects: ReleaseSurfaceInstallationReceipt["systemEffects"] = [
  {
    id: "windows-product-registration",
    status: "pass",
    observed: "HKCU product registration points to the fixture target",
    details: {
      registryPath: "HKCU\\Software\\shellx\\shellX",
      installLocation: "C:\\Program Files\\ShellX",
    },
  },
  {
    id: "windows-uninstall-registration",
    status: "pass",
    observed: "HKCU uninstall registration points to the fixture target",
    details: {
      registryPath: "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\shellX",
      displayName: "shellX",
      displayVersion: releaseSurfaceFixtureVersion,
      publisher: "shellx",
      mainBinaryName: "shellx.exe",
      installLocation: "C:\\Program Files\\ShellX",
      uninstallExecutable: "C:\\Program Files\\ShellX\\uninstall.exe",
      displayIcon: "C:\\Program Files\\ShellX\\shellx.exe",
      noModify: 1,
      noRepair: 1,
    },
  },
  {
    id: "windows-shortcuts-suppressed",
    status: "pass",
    observed: "The fixture observed /NS shortcut suppression",
    details: { startMenuAbsent: true, desktopAbsent: true },
  },
  {
    id: "windows-explorer-handoff-suppressed",
    status: "pass",
    observed: "The fixture observed silent Explorer handoff suppression",
    details: { fileContextMenuAbsent: true, directoryContextMenuAbsent: true, sendToAbsent: true },
  },
];
const approvedWindowsSignature = {
  kind: "windows-authenticode" as const,
  collector: "windows-powershell-authenticode-v1" as const,
  status: "Valid" as const,
  verifiedAt: "2026-07-28T17:57:00.000Z",
  publisher: { commonName: "U1C", organization: "U1C", country: "LV" },
  verificationPolicy: {
    provider: "azure-artifact-signing" as const,
    expectedEndpointHost: "fixture.codesigning.azure.net",
    expectedAccountName: "fixture-account",
    expectedProfileName: "fixture-profile",
    metadata: { basename: "shellx-artifact-signing-metadata.json", sha256: "a".repeat(64), bytes: 512 },
  },
  signerCertificate: {
    subject: "CN=U1C, O=U1C, C=LV",
    issuer: "CN=Microsoft ID Verified CS AOC CA 04, O=Microsoft Corporation, C=US",
    thumbprint: "a".repeat(40),
    serialNumber: "a".repeat(16),
    notBefore: "2026-07-01T00:00:00.000Z",
    notAfter: "2026-08-01T00:00:00.000Z",
  },
  timestampCertificate: {
    subject: "CN=Microsoft Public RSA Time Stamping Authority",
    issuer: "CN=Microsoft Public RSA Timestamping CA 2020, O=Microsoft Corporation, C=US",
    thumbprint: "b".repeat(40),
    serialNumber: "b".repeat(16),
    notBefore: "2026-01-01T00:00:00.000Z",
    notAfter: "2027-01-01T00:00:00.000Z",
  },
};
const installationReceipt = {
  schema: RELEASE_SURFACE_INSTALLATION_RECEIPT_SCHEMA,
  platform: "windows-installed",
  sourceCommit: "b".repeat(40),
  version: releaseSurfaceFixtureVersion,
  createdAt: "2026-07-28T17:59:00.000Z",
  method: "installer-observed",
  status: "pass",
  distributionArtifact: artifact,
  installedPayload: installedFromInstaller,
  coverage: { payload: "complete-target-root", systemEffects: "declared-subset" },
  systemEffects: installerSystemEffects,
  nativeWindowsNsisObservation: {
    schema: "shellx/release-surface-windows-nsis-installation@1",
    collector: "windows-powershell-nsis-v1",
    orchestrator: "native",
    userName: "SHELLX-TEST\\release-fixture",
    userSid: "S-1-5-21-1000-1001-1002-1003",
    userIsAdministrator: false,
    userIsAdministratorsMember: false,
    artifact: {
      ...artifact,
      path: `C:\\Release Evidence\\ShellX_${releaseSurfaceFixtureVersion}_x64-setup.exe`,
      signatureStatus: "Valid",
      signerThumbprint: approvedWindowsSignature.signerCertificate.thumbprint,
      signerSubject: approvedWindowsSignature.signerCertificate.subject,
      signerIssuer: approvedWindowsSignature.signerCertificate.issuer,
      timestampSubject: approvedWindowsSignature.timestampCertificate.subject,
      timestampIssuer: approvedWindowsSignature.timestampCertificate.issuer,
      timestampThumbprint: approvedWindowsSignature.timestampCertificate.thumbprint,
    },
    operation: {
      startedAt: "2026-07-28T17:58:30.000Z",
      completedAt: "2026-07-28T17:58:50.000Z",
      exitCode: 0,
      targetRootStateBefore: "absent",
      arguments: ["/S", "/NS", "/D=<redacted-run-owned-target>"],
    },
    targetRoot: "C:\\Program Files\\ShellX",
    mainExecutablePath: installedFromInstaller.path,
    expectedVersion: releaseSurfaceFixtureVersion,
    webView2Identity: [{ scope: "machine-wow6432", version: "138.0.3351.121" }],
    safety: {
      machineRegistrationsBefore: [],
      machineRegistrationsAfter: [],
      shellxProcessCountBefore: 0,
      shellxProcessCountAfter: 0,
      webView2IdentityUnchanged: true,
    },
    systemEffects: installerSystemEffects,
  },
  signatureReceipt: {
    basename: "windows-signature.json",
    sha256: "e".repeat(64),
    bytes: 1024,
  },
  windowsSignatureVerification: approvedWindowsSignature,
  operation: {
    adapter: "windows-nsis-install-v1",
    orchestrator: "native",
    startedAt: "2026-07-28T17:58:30.000Z",
    completedAt: "2026-07-28T17:58:50.000Z",
    targetRootStateBefore: "absent",
    exitCode: 0,
  },
  payloadManifest: installerPayloadManifest,
  manifestVerification: {
    firstCollectedAt: "2026-07-28T17:58:51.000Z",
    secondCollectedAt: installerPayloadManifest.collectedAt,
    firstManifestSha256: installerPayloadManifest.manifestSha256,
    secondManifestSha256: installerPayloadManifest.manifestSha256,
  },
  checks: ["disposable-user-baseline", "artifact-signature-valid", "artifact-unchanged", "target-absent", "installer-exit-zero", "payload-created", "payload-hash-recomputed", "manifest-double-collected", "system-effects-observed", "machine-registration-absent", "process-autolaunch-absent", "webview2-unchanged"].map((id) => ({
    id,
    status: "pass" as const,
    observed: `${id} was observed by the isolated Windows installer adapter`,
  })),
} satisfies ReleaseSurfaceInstallationReceipt;
assert.deepEqual(validateReleaseSurfaceInstallationReceipt({
  receipt: installationReceipt,
  platform: "windows-installed",
  sourceCommit: "b".repeat(40),
  version: releaseSurfaceFixtureVersion,
  method: "installer-observed",
  artifact,
  installedPayload: installedFromInstaller,
}), []);
const failedInstallation = structuredClone(installationReceipt) as ReleaseSurfaceInstallationReceipt;
failedInstallation.checks[0]!.status = "fail";
assert(
  validateReleaseSurfaceInstallationReceipt({
    receipt: failedInstallation,
    platform: "windows-installed",
    sourceCommit: "b".repeat(40),
    version: releaseSurfaceFixtureVersion,
    method: "installer-observed",
    artifact,
    installedPayload: installedFromInstaller,
  }).some((error) => error.includes("must pass")),
  "candidate evidence must reject a failed native installation check",
);
assert(
  validateReleaseSurfaceInstallationReceipt({
    receipt: { status: "pass" } as ReleaseSurfaceInstallationReceipt,
    platform: "windows-installed",
    sourceCommit: "b".repeat(40),
    version: releaseSurfaceFixtureVersion,
    method: "installer-observed",
    artifact,
    installedPayload: installedFromInstaller,
  }).length >= 6,
  "an arbitrary pass object must not satisfy the parsed native installation contract",
);
assert.deepEqual(validateReleaseSurfaceEvidenceTimeline({
  installationCreatedAt: "2026-07-28T17:59:00.000Z",
  attestationCreatedAt: "2026-07-28T17:59:30.000Z",
  runStartedAt: "2026-07-28T18:00:00.000Z",
  now: Date.parse("2026-07-28T18:01:00.000Z"),
}), []);
assert(
  validateReleaseSurfaceEvidenceTimeline({
    installationCreatedAt: "2026-07-28T18:00:01.000Z",
    attestationCreatedAt: "2026-07-28T18:00:00.000Z",
    runStartedAt: "2026-07-28T18:00:02.000Z",
    now: Date.parse("2026-07-28T18:01:00.000Z"),
  }).some((error) => error.includes("must precede")),
  "installation evidence created after attestation must be rejected",
);

const runtimeTemp = mkdtempSync(join(tmpdir(), "shellx-candidate-token-"));
const runtimeTokenPath = join(runtimeTemp, "shellxagent.token");
writeFileSync(runtimeTokenPath, "fixture-debug-token-that-is-long-enough", { encoding: "utf8", mode: 0o600 });
const server = createServer((request, response) => {
  assert(["/health", "/browser/state"].includes(request.url ?? ""));
  assert.equal(request.headers.authorization, "Bearer fixture-debug-token-that-is-long-enough");
  const address = server.address();
  assert(address && typeof address === "object");
  response.writeHead(200, { "content-type": "application/json" });
  if (request.url === "/browser/state") {
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  response.end(JSON.stringify({
    ok: true,
    processId: 4321,
    instanceId: "fixture-instance-0001",
    appVersion,
    buildCommit: "b".repeat(40),
    debugApiPort: address.port,
  }));
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
try {
  const address = server.address();
  assert(address && typeof address === "object");
  const request = runtimeRequest(`http://127.0.0.1:${address.port}`, runtimeTokenPath);
  const connection = await resolveReleaseSurfaceRuntimeCandidate(request);
  assert.equal(connection.base, request.runtime.debugBase);
  const mismatched = structuredClone(request);
  mismatched.runtime.instanceId = "different-instance-01";
  await assert.rejects(
    resolveReleaseSurfaceRuntimeCandidate(mismatched),
    /instanceId does not match/,
    "every real driver must re-probe the exact attested process instance",
  );
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  rmSync(runtimeTemp, { recursive: true });
}

console.log("Release surface candidate attestation tests passed");

function runtimeRequest(debugBase: string, debugTokenPath: string): ReleaseSurfaceDriverRequest {
  return {
    schema: RELEASE_SURFACE_DRIVER_REQUEST_SCHEMA,
    mode: "final-frozen-candidate",
    driverId: "fixture-installed",
    driverKind: "tauri-command",
    platform: "linux-installed",
    sourceCommit: "b".repeat(40),
    version: appVersion,
    inventoryDigest: "e".repeat(64),
    artifact: { basename: artifact.basename, sha256: artifact.sha256 },
    controller: syntheticReleaseSurfaceControllerBinding("b".repeat(40)),
    runtime: {
      processId: 4321,
      instanceId: "fixture-instance-0001",
      debugBase,
      debugTokenPath,
      mcpBase: "http://127.0.0.1:9",
      mcpTokenPath: debugTokenPath,
      executableSha256: artifact.sha256,
      installedPayloadPath: "/opt/shellx/shellx",
      installedManifestSha256: "e".repeat(64),
    },
    assignments: [{
      surface: {
        id: "tauri-command:fixture",
        kind: "tauri-command",
        name: "fixture",
        source: "fixture.rs",
        platforms: ["linux-installed"],
        delivery: "installed-app",
      },
      fixtureId: "fixture:isolated-profile",
      expectedEffect: "fixture effect",
      oracleId: "fixture:effect",
      cleanupId: "fixture:cleanup",
    }],
  };
}

function payloadManifest(input: {
  platform: "windows-installed" | "macos-installed" | "linux-installed";
  scope: "staged-direct-file" | "installer-target-root";
  rootPath: string;
  mainExecutableRelativePath: string;
  sha256: string;
  bytes: number;
  collectedAt: string;
}): ReleaseSurfaceInstalledPayloadManifest {
  const manifest: ReleaseSurfaceInstalledPayloadManifest = {
    schema: RELEASE_SURFACE_INSTALLED_PAYLOAD_MANIFEST_SCHEMA,
    platform: input.platform,
    collector: input.platform === "windows-installed" ? "windows-powershell-payload-v1" : "node-filesystem-v1",
    orchestrator: "native",
    scope: input.scope,
    rootPath: input.rootPath,
    collectedAt: input.collectedAt,
    mainExecutableRelativePath: input.mainExecutableRelativePath,
    entries: [{
      path: input.mainExecutableRelativePath,
      kind: "file",
      sha256: input.sha256,
      bytes: input.bytes,
    }],
    entryCount: 1,
    totalFileBytes: input.bytes,
    manifestSha256: "",
  };
  manifest.manifestSha256 = releaseSurfaceInstalledPayloadManifestDigest(manifest);
  return manifest;
}
