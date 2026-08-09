import { readFileSync } from "node:fs";
import type { ReleaseSurfaceFileIdentity } from "./release-surface-candidate-attestation";
import type { ReleasePlatform } from "./release-surface-inventory";
import {
  validateReleaseSurfaceInstalledPayloadManifest,
  type ReleaseSurfaceInstalledPayloadManifest,
} from "./release-surface-installed-payload-manifest";
import {
  validateReleaseSurfaceLinuxDebInstallationObservation,
  type ReleaseSurfaceLinuxDebInstallationObservation,
} from "./release-surface-linux-deb-installation";
import {
  validateReleaseSurfaceWindowsNsisInstallationObservation,
  type ReleaseSurfaceWindowsNsisInstallationObservation,
} from "./release-surface-windows-nsis-installation";
import {
  validateReleaseSurfaceMacosDmgInstallationObservation,
  type ReleaseSurfaceMacosDmgInstallationObservation,
} from "./release-surface-macos-dmg-installation";
import {
  validateReleaseSurfaceNativeSignatureVerification,
  type ReleaseSurfaceNativeSignatureVerification,
} from "./release-surface-signature-receipt";

export const RELEASE_SURFACE_INSTALLATION_RECEIPT_SCHEMA =
  "shellx/release-surface-installation-receipt@4";

export interface ReleaseSurfaceInstallationSystemEffect {
  id: string;
  status: "pass" | "fail";
  observed: string;
  details: Record<string, unknown>;
}

export interface ReleaseSurfaceInstallationReceipt {
  schema: typeof RELEASE_SURFACE_INSTALLATION_RECEIPT_SCHEMA;
  platform: ReleasePlatform;
  sourceCommit: string;
  version: string;
  createdAt: string;
  method: "direct-artifact" | "installer-observed";
  status: "pass" | "fail";
  distributionArtifact: ReleaseSurfaceFileIdentity;
  installedPayload: ReleaseSurfaceFileIdentity & { path: string };
  coverage: {
    payload: "staged-direct-file" | "complete-target-root";
    systemEffects: "not-observed" | "declared-subset";
  };
  systemEffects: ReleaseSurfaceInstallationSystemEffect[];
  nativeWindowsNsisObservation?: ReleaseSurfaceWindowsNsisInstallationObservation;
  nativeLinuxDebObservation?: ReleaseSurfaceLinuxDebInstallationObservation;
  nativeMacosDmgObservation?: ReleaseSurfaceMacosDmgInstallationObservation;
  signatureReceipt?: ReleaseSurfaceFileIdentity;
  windowsSignatureVerification?: Extract<ReleaseSurfaceNativeSignatureVerification, { kind: "windows-authenticode" }>;
  macosSignatureVerification?: Extract<ReleaseSurfaceNativeSignatureVerification, { kind: "macos-codesign" }>;
  linuxDigestVerification?: Extract<ReleaseSurfaceNativeSignatureVerification, { kind: "artifact-digest" }>;
  operation: {
    adapter:
      | "windows-direct-stage-v1"
      | "macos-direct-stage-v1"
      | "linux-direct-stage-v1"
      | "windows-nsis-install-v1"
      | "macos-dmg-install-v1"
      | "linux-package-install-v1";
    orchestrator: "native" | "wsl";
    startedAt: string;
    completedAt: string;
    targetRootStateBefore: "absent";
    exitCode?: number;
  };
  payloadManifest: ReleaseSurfaceInstalledPayloadManifest;
  manifestVerification: {
    firstCollectedAt: string;
    secondCollectedAt: string;
    firstManifestSha256: string;
    secondManifestSha256: string;
  };
  checks: Array<{ id: string; status: "pass" | "fail"; observed: string }>;
}

const INSTALLER_CHECKS: Record<ReleasePlatform, string[]> = {
  "windows-installed": [
    "disposable-user-baseline",
    "artifact-signature-valid",
    "artifact-unchanged",
    "target-absent",
    "installer-exit-zero",
    "payload-created",
    "payload-hash-recomputed",
    "manifest-double-collected",
    "system-effects-observed",
    "machine-registration-absent",
    "process-autolaunch-absent",
    "webview2-unchanged",
  ],
  "macos-installed": [
    "artifact-signature-valid",
    "artifact-unchanged",
    "target-absent",
    "image-mounted-readonly",
    "app-copied-without-overwrite",
    "payload-hash-recomputed",
    "manifest-double-collected",
    "system-effects-observed",
    "process-autolaunch-absent",
    "image-detached",
  ],
  "linux-installed": [
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
  ],
};
const DIRECT_ARTIFACT_CHECKS = ["target-absent", "payload-staged", "payload-hash-recomputed", "manifest-double-collected"];

const DIRECT_ADAPTERS: Record<ReleasePlatform, ReleaseSurfaceInstallationReceipt["operation"]["adapter"]> = {
  "windows-installed": "windows-direct-stage-v1",
  "macos-installed": "macos-direct-stage-v1",
  "linux-installed": "linux-direct-stage-v1",
};
const INSTALLER_ADAPTERS: Record<ReleasePlatform, ReleaseSurfaceInstallationReceipt["operation"]["adapter"]> = {
  "windows-installed": "windows-nsis-install-v1",
  "macos-installed": "macos-dmg-install-v1",
  "linux-installed": "linux-package-install-v1",
};

export function loadReleaseSurfaceInstallationReceipt(path: string): ReleaseSurfaceInstallationReceipt {
  return JSON.parse(readFileSync(path, "utf8")) as ReleaseSurfaceInstallationReceipt;
}

export function validateReleaseSurfaceInstallationReceipt(input: {
  receipt: ReleaseSurfaceInstallationReceipt;
  platform: ReleasePlatform;
  sourceCommit: string;
  version: string;
  method: "direct-artifact" | "installer-observed";
  artifact: ReleaseSurfaceFileIdentity;
  installedPayload: ReleaseSurfaceFileIdentity & { path: string };
}): string[] {
  const { receipt, platform, sourceCommit, version, method, artifact, installedPayload } = input;
  const errors: string[] = [];
  if (receipt.schema !== RELEASE_SURFACE_INSTALLATION_RECEIPT_SCHEMA) {
    errors.push(`installation receipt schema must be ${RELEASE_SURFACE_INSTALLATION_RECEIPT_SCHEMA}`);
  }
  if (receipt.platform !== platform) errors.push(`installation receipt platform must be ${platform}`);
  if (receipt.sourceCommit !== sourceCommit) errors.push("installation receipt source commit does not match");
  if (receipt.version !== version) errors.push("installation receipt version does not match");
  if (receipt.method !== method) errors.push(`installation receipt method must be ${method}`);
  if (!Number.isFinite(Date.parse(receipt.createdAt))) errors.push("installation receipt createdAt must be a valid ISO timestamp");
  if (receipt.status !== "pass") errors.push("installation receipt status must pass");
  compareIdentity(errors, "installation distribution artifact", receipt.distributionArtifact, artifact, false);
  compareIdentity(errors, "installation payload", receipt.installedPayload, installedPayload, true);
  errors.push(...validateReleaseSurfaceInstalledPayloadManifest(receipt.payloadManifest));
  if (receipt.payloadManifest?.platform !== platform) errors.push("installation manifest platform does not match receipt");
  const expectedScope = method === "direct-artifact" ? "staged-direct-file" : "installer-target-root";
  if (receipt.payloadManifest?.scope !== expectedScope) errors.push(`installation manifest scope must be ${expectedScope}`);
  const expectedCoverage = method === "direct-artifact" ? "staged-direct-file" : "complete-target-root";
  if (receipt.coverage?.payload !== expectedCoverage) errors.push(`installation payload coverage must be ${expectedCoverage}`);
  validateSystemEffects(errors, receipt, platform, method);
  validateNativeWindowsNsisObservation(errors, receipt, platform, method);
  validateNativeLinuxDebObservation(errors, receipt, platform, method);
  validateNativeMacosDmgObservation(errors, receipt, platform, method);
  validateInstallerSignatureBinding(errors, receipt, platform, method);
  const expectedAdapter = method === "direct-artifact" ? DIRECT_ADAPTERS[platform] : INSTALLER_ADAPTERS[platform];
  if (receipt.operation?.adapter !== expectedAdapter) errors.push(`installation adapter must be ${expectedAdapter}`);
  if (!( ["native", "wsl"] as string[]).includes(receipt.operation?.orchestrator)) errors.push("installation orchestrator is invalid");
  if (platform !== "windows-installed" && receipt.operation?.orchestrator === "wsl") {
    errors.push("WSL orchestration is valid only for a Windows installation target");
  }
  if (receipt.operation?.targetRootStateBefore !== "absent") errors.push("installation target root must be proven absent before operation");
  if (method === "direct-artifact"
    && (receipt.distributionArtifact?.sha256 !== receipt.installedPayload?.sha256
      || receipt.distributionArtifact?.bytes !== receipt.installedPayload?.bytes)) {
    errors.push("direct-artifact installed payload must match the distribution artifact bytes");
  }
  const operationStart = Date.parse(receipt.operation?.startedAt);
  const operationEnd = Date.parse(receipt.operation?.completedAt);
  if (!Number.isFinite(operationStart) || !Number.isFinite(operationEnd) || operationEnd < operationStart) {
    errors.push("installation operation timestamps must be valid and ordered");
  }
  if (method === "installer-observed" && receipt.operation?.exitCode !== 0) errors.push("installer-observed operation exitCode must be zero");
  if (method === "direct-artifact" && receipt.operation?.exitCode !== undefined) errors.push("direct-artifact operation must not claim an installer exitCode");
  validateManifestVerification(errors, receipt);
  validateManifestMainExecutable(errors, receipt, installedPayload, platform);
  const checks = new Map((receipt.checks ?? []).map((check) => [check.id, check]));
  if (checks.size !== (receipt.checks ?? []).length) errors.push("installation receipt check ids must be unique");
  const requiredChecks = method === "direct-artifact" ? DIRECT_ARTIFACT_CHECKS : INSTALLER_CHECKS[platform];
  for (const id of requiredChecks) {
    const check = checks.get(id);
    if (!check) errors.push(`installation receipt is missing check ${id}`);
    else {
      if (check.status !== "pass") errors.push(`installation receipt check ${id} must pass`);
      if (!check.observed?.trim()) errors.push(`installation receipt check ${id} requires an observation`);
    }
  }
  for (const id of checks.keys()) {
    if (!requiredChecks.includes(id)) {
      errors.push(`installation receipt check ${id} is not declared for ${platform} ${method}`);
    }
  }
  return errors;
}

function validateInstallerSignatureBinding(
  errors: string[],
  receipt: ReleaseSurfaceInstallationReceipt,
  platform: ReleasePlatform,
  method: ReleaseSurfaceInstallationReceipt["method"],
): void {
  const requiresWindowsSignature = platform === "windows-installed" && method === "installer-observed";
  const requiresLinuxDigest = platform === "linux-installed" && method === "installer-observed";
  const requiresMacosSignature = platform === "macos-installed" && method === "installer-observed";
  const requiresSignatureReceipt = requiresWindowsSignature || requiresMacosSignature || requiresLinuxDigest;
  if (!requiresSignatureReceipt) {
    if (receipt.signatureReceipt !== undefined || receipt.windowsSignatureVerification !== undefined
      || receipt.macosSignatureVerification !== undefined || receipt.linuxDigestVerification !== undefined) {
      errors.push("installation signature receipt binding is valid only for a native signed installer adapter");
    }
    return;
  }
  const identity = receipt.signatureReceipt;
  if (!identity?.basename?.trim() || !/^[a-f0-9]{64}$/.test(identity.sha256 ?? "")
    || !Number.isSafeInteger(identity.bytes) || identity.bytes <= 0) {
    errors.push("installer-observed receipt requires the exact validated signature receipt identity");
  }
  if (requiresWindowsSignature) {
    if (receipt.macosSignatureVerification !== undefined || receipt.linuxDigestVerification !== undefined) {
      errors.push("Windows installer-observed receipt must contain only Windows signature evidence");
    }
    if (receipt.windowsSignatureVerification?.kind !== "windows-authenticode") {
      errors.push("Windows installer-observed receipt requires structured approved signing-profile evidence");
      return;
    }
    errors.push(...validateReleaseSurfaceNativeSignatureVerification({
      native: receipt.windowsSignatureVerification,
      platform: "windows-installed",
      artifact: receipt.distributionArtifact,
    }).map((error) => `Windows installation signing profile: ${error}`));
    return;
  }
  if (requiresMacosSignature) {
    if (receipt.windowsSignatureVerification !== undefined || receipt.linuxDigestVerification !== undefined) {
      errors.push("macOS installer-observed receipt must contain only macOS signature evidence");
    }
    if (receipt.macosSignatureVerification?.kind !== "macos-codesign") {
      errors.push("macOS installer-observed receipt requires structured Developer ID and notarization evidence");
      return;
    }
    errors.push(...validateReleaseSurfaceNativeSignatureVerification({
      native: receipt.macosSignatureVerification,
      platform: "macos-installed",
      artifact: receipt.distributionArtifact,
    }).map((error) => `macOS installation signing profile: ${error}`));
    return;
  }
  if (receipt.windowsSignatureVerification !== undefined || receipt.macosSignatureVerification !== undefined) {
    errors.push("Linux installer-observed receipt must contain only Linux artifact-digest evidence");
  }
  if (receipt.linuxDigestVerification?.kind !== "artifact-digest") {
    errors.push("Linux installer-observed receipt requires structured artifact-digest evidence");
    return;
  }
  errors.push(...validateReleaseSurfaceNativeSignatureVerification({
    native: receipt.linuxDigestVerification,
    platform: "linux-installed",
    artifact: receipt.distributionArtifact,
  }).map((error) => `Linux installation artifact digest: ${error}`));
}

function validateNativeMacosDmgObservation(
  errors: string[],
  receipt: ReleaseSurfaceInstallationReceipt,
  platform: ReleasePlatform,
  method: ReleaseSurfaceInstallationReceipt["method"],
): void {
  const requiresObservation = platform === "macos-installed" && method === "installer-observed";
  if (!requiresObservation) {
    if (receipt.nativeMacosDmgObservation !== undefined) {
      errors.push("native macOS DMG observation is valid only for a macOS installer-observed receipt");
    }
    return;
  }
  if (!receipt.nativeMacosDmgObservation) {
    errors.push("macOS installer-observed receipt requires its structured native DMG observation");
    return;
  }
  errors.push(...validateReleaseSurfaceMacosDmgInstallationObservation({
    observation: receipt.nativeMacosDmgObservation,
    artifact: receipt.distributionArtifact,
    artifactPath: receipt.nativeMacosDmgObservation.artifact.path,
    targetApp: receipt.payloadManifest.rootPath,
    approvedSignature: receipt.macosSignatureVerification!,
    targetManifest: receipt.payloadManifest,
  }).map((error) => `macOS DMG receipt: ${error}`));
  if (receipt.nativeMacosDmgObservation.operation.startedAt !== receipt.operation.startedAt
    || receipt.nativeMacosDmgObservation.operation.completedAt !== receipt.operation.completedAt) {
    errors.push("macOS DMG observation operation does not bind the receipt");
  }
  if (receipt.nativeMacosDmgObservation.targetApplication.executableRelativePath
      !== receipt.payloadManifest.mainExecutableRelativePath
    || receipt.installedPayload.path !== joinPlatformPath(
      receipt.payloadManifest.rootPath,
      receipt.payloadManifest.mainExecutableRelativePath,
      platform,
    )
    || receipt.installedPayload.sha256 !== receipt.nativeMacosDmgObservation.targetApplication.executable.sha256
    || receipt.installedPayload.bytes !== receipt.nativeMacosDmgObservation.targetApplication.executable.bytes) {
    errors.push("macOS DMG installed executable does not bind the receipt payload");
  }
  if (JSON.stringify(receipt.nativeMacosDmgObservation.systemEffects) !== JSON.stringify(receipt.systemEffects)) {
    errors.push("macOS DMG observation system effects do not exactly match the receipt claims");
  }
}

function validateNativeLinuxDebObservation(
  errors: string[],
  receipt: ReleaseSurfaceInstallationReceipt,
  platform: ReleasePlatform,
  method: ReleaseSurfaceInstallationReceipt["method"],
): void {
  const requiresObservation = platform === "linux-installed" && method === "installer-observed";
  if (!requiresObservation) {
    if (receipt.nativeLinuxDebObservation !== undefined) {
      errors.push("native Linux Debian observation is valid only for a Linux installer-observed receipt");
    }
    return;
  }
  const observation = receipt.nativeLinuxDebObservation;
  if (!observation) {
    errors.push("Linux installer-observed receipt requires its structured native Debian observation");
    return;
  }
  errors.push(...validateReleaseSurfaceLinuxDebInstallationObservation({
    observation,
    artifact: receipt.distributionArtifact,
    artifactPath: observation.artifact.path,
    targetRoot: receipt.payloadManifest.rootPath,
    expectedVersion: receipt.version,
  }).map((error) => `Linux Debian receipt: ${error}`));
  if (observation.operation.startedAt !== receipt.operation.startedAt
    || observation.operation.completedAt !== receipt.operation.completedAt
    || joinPlatformPath(receipt.payloadManifest.rootPath, observation.package.mainExecutableRelativePath, platform)
      !== receipt.installedPayload.path) {
    errors.push("Linux Debian observation operation or installed executable does not bind the receipt");
  }
  if (JSON.stringify(observation.systemEffects) !== JSON.stringify(receipt.systemEffects)) {
    errors.push("Linux Debian observation system effects do not exactly match the receipt claims");
  }
}

function validateNativeWindowsNsisObservation(
  errors: string[],
  receipt: ReleaseSurfaceInstallationReceipt,
  platform: ReleasePlatform,
  method: ReleaseSurfaceInstallationReceipt["method"],
): void {
  const requiresObservation = platform === "windows-installed" && method === "installer-observed";
  if (!requiresObservation) {
    if (receipt.nativeWindowsNsisObservation !== undefined) {
      errors.push("native Windows NSIS observation is valid only for a Windows installer-observed receipt");
    }
    return;
  }
  const observation = receipt.nativeWindowsNsisObservation;
  if (!observation) {
    errors.push("Windows installer-observed receipt requires its structured native NSIS observation");
    return;
  }
  errors.push(...validateReleaseSurfaceWindowsNsisInstallationObservation({
    observation,
    orchestrator: receipt.operation.orchestrator,
    expectedUser: observation.userName,
    expectedVersion: receipt.version,
    artifact: receipt.distributionArtifact,
    artifactPath: observation.artifact.path,
    targetRoot: receipt.payloadManifest.rootPath,
    approvedSignature: receipt.windowsSignatureVerification!,
  }).map((error) => `Windows NSIS receipt: ${error}`));
  if (observation.operation.startedAt !== receipt.operation.startedAt
    || observation.operation.completedAt !== receipt.operation.completedAt
    || observation.mainExecutablePath !== receipt.installedPayload.path) {
    errors.push("Windows NSIS observation operation or installed executable does not bind the receipt");
  }
  if (JSON.stringify(observation.systemEffects) !== JSON.stringify(receipt.systemEffects)) {
    errors.push("Windows NSIS observation system effects do not exactly match the receipt claims");
  }
}

function validateManifestVerification(
  errors: string[],
  receipt: ReleaseSurfaceInstallationReceipt,
): void {
  const verification = receipt.manifestVerification;
  const first = Date.parse(verification?.firstCollectedAt);
  const second = Date.parse(verification?.secondCollectedAt);
  const completed = Date.parse(receipt.operation?.completedAt);
  const created = Date.parse(receipt.createdAt);
  if (![first, second, completed, created].every(Number.isFinite) || first < completed || second < first || created < second) {
    errors.push("installation manifest collection timestamps must follow operation completion and be ordered");
  }
  if (verification?.firstManifestSha256 !== receipt.payloadManifest?.manifestSha256
    || verification?.secondManifestSha256 !== receipt.payloadManifest?.manifestSha256) {
    errors.push("installation manifest double collection must match the persisted manifest digest");
  }
  if (verification?.secondCollectedAt !== receipt.payloadManifest?.collectedAt) {
    errors.push("installation persisted manifest must be the second collected snapshot");
  }
}

function validateSystemEffects(
  errors: string[],
  receipt: ReleaseSurfaceInstallationReceipt,
  platform: ReleasePlatform,
  method: ReleaseSurfaceInstallationReceipt["method"],
): void {
  const effects = receipt.systemEffects ?? [];
  if (!Array.isArray(receipt.systemEffects)) errors.push("installation systemEffects must be an array");
  const requiresWindowsEffects = platform === "windows-installed" && method === "installer-observed";
  const requiresLinuxEffects = platform === "linux-installed" && method === "installer-observed";
  const requiresMacosEffects = platform === "macos-installed" && method === "installer-observed";
  const expectedCoverage = requiresWindowsEffects || requiresMacosEffects || requiresLinuxEffects
    ? "declared-subset"
    : "not-observed";
  if (receipt.coverage?.systemEffects !== expectedCoverage) {
    errors.push(`installation system-effect coverage must be ${expectedCoverage}`);
  }
  if (!requiresWindowsEffects && !requiresMacosEffects && !requiresLinuxEffects) {
    if (effects.length !== 0) errors.push("installation must not claim system effects without a native structured adapter");
    return;
  }
  if (requiresMacosEffects) {
    const observation = receipt.nativeMacosDmgObservation;
    if (!observation || JSON.stringify(observation.systemEffects) !== JSON.stringify(effects)) {
      errors.push("macOS installation system effects must come from the native DMG observation");
    }
    return;
  }
  const byId = new Map(effects.map((effect) => [effect.id, effect]));
  if (byId.size !== effects.length) errors.push("installation system-effect ids must be unique");
  const required = requiresWindowsEffects ? [
    "windows-product-registration",
    "windows-uninstall-registration",
    "windows-shortcuts-suppressed",
    "windows-explorer-handoff-suppressed",
  ] : [
    "linux-package-database-unchanged",
    "linux-process-autolaunch-absent",
    "linux-host-integration-unchanged",
    "linux-maintainer-scripts-not-executed",
  ];
  for (const effect of effects) {
    if (!required.includes(effect.id)) errors.push(`installation system effect ${effect.id} is not declared for the structured ${platform} adapter`);
    if (effect.status !== "pass") errors.push(`installation system effect ${effect.id} must pass`);
    if (!effect.observed?.trim()) errors.push(`installation system effect ${effect.id} requires an observation`);
    if (!effect.details || typeof effect.details !== "object" || Array.isArray(effect.details)) {
      errors.push(`installation system effect ${effect.id} requires structured details`);
    }
  }
  for (const id of required) {
    if (!byId.has(id)) errors.push(`installation system effects are missing ${id}`);
  }
  if (requiresLinuxEffects) {
    const database = byId.get("linux-package-database-unchanged")?.details;
    if (database?.backend !== "dpkg-status" || database?.beforeSha256 !== database?.afterSha256
      || !/^[a-f0-9]{64}$/.test(String(database?.beforeSha256 ?? ""))) {
      errors.push("Linux package database unchanged effect is incomplete");
    }
    const processes = byId.get("linux-process-autolaunch-absent")?.details;
    if (JSON.stringify(processes?.beforeProcessIds) !== "[]" || JSON.stringify(processes?.afterProcessIds) !== "[]") {
      errors.push("Linux process non-autolaunch effect is incomplete");
    }
    const integration = byId.get("linux-host-integration-unchanged")?.details;
    if (!Array.isArray(integration?.targetsChecked) || integration.targetsChecked.length === 0
      || JSON.stringify(integration?.beforePresent) !== "[]" || JSON.stringify(integration?.afterPresent) !== "[]") {
      errors.push("Linux host integration unchanged effect is incomplete");
    }
    const scripts = byId.get("linux-maintainer-scripts-not-executed")?.details;
    if (!Array.isArray(scripts?.scriptsPresent) || scripts?.executionMode !== "data-payload-extraction"
      || scripts?.executed !== false) {
      errors.push("Linux maintainer-script non-execution effect is incomplete");
    }
    return;
  }
  const product = byId.get("windows-product-registration")?.details;
  if (product?.registryPath !== "HKCU\\Software\\shellx\\shellX"
    || !samePlatformPath(String(product?.installLocation ?? ""), receipt.payloadManifest.rootPath, platform)) {
    errors.push("Windows product registration does not bind the installed target root");
  }
  const uninstall = byId.get("windows-uninstall-registration")?.details;
  if (uninstall?.registryPath !== "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\shellX"
    || uninstall?.displayName !== "shellX"
    || uninstall?.displayVersion !== receipt.version
    || uninstall?.publisher !== "shellx"
    || uninstall?.mainBinaryName !== "shellx.exe"
    || !samePlatformPath(String(uninstall?.installLocation ?? ""), receipt.payloadManifest.rootPath, platform)
    || !samePlatformPath(
      String(uninstall?.uninstallExecutable ?? ""),
      joinPlatformPath(receipt.payloadManifest.rootPath, "uninstall.exe", platform),
      platform,
    )
    || !samePlatformPath(
      String(uninstall?.displayIcon ?? ""),
      joinPlatformPath(receipt.payloadManifest.rootPath, "shellx.exe", platform),
      platform,
    )
    || uninstall?.noModify !== 1
    || uninstall?.noRepair !== 1) {
    errors.push("Windows uninstall registration is incomplete or does not bind the installed target root");
  }
  const shortcuts = byId.get("windows-shortcuts-suppressed")?.details;
  if (shortcuts?.startMenuAbsent !== true || shortcuts?.desktopAbsent !== true) {
    errors.push("Windows /NS shortcut suppression was not proven");
  }
  const handoff = byId.get("windows-explorer-handoff-suppressed")?.details;
  if (handoff?.fileContextMenuAbsent !== true || handoff?.directoryContextMenuAbsent !== true
    || handoff?.sendToAbsent !== true) {
    errors.push("Windows silent Explorer handoff suppression was not proven");
  }
}

function validateManifestMainExecutable(
  errors: string[],
  receipt: ReleaseSurfaceInstallationReceipt,
  installedPayload: ReleaseSurfaceFileIdentity & { path: string },
  platform: ReleasePlatform,
): void {
  const manifest = receipt.payloadManifest;
  if (!manifest) return;
  const entry = manifest.entries?.find((candidate) => candidate.path === manifest.mainExecutableRelativePath);
  if (!entry || entry.kind !== "file" || entry.sha256 !== installedPayload.sha256 || entry.bytes !== installedPayload.bytes) {
    errors.push("installation manifest main executable identity does not match installed payload");
  }
  const manifestPayloadPath = joinPlatformPath(manifest.rootPath, manifest.mainExecutableRelativePath, platform);
  if (!samePlatformPath(manifestPayloadPath, installedPayload.path, platform)) {
    errors.push("installation manifest main executable path does not match installed payload");
  }
}

export function validateReleaseSurfaceEvidenceTimeline(input: {
  installationCreatedAt: string;
  attestationCreatedAt: string;
  runStartedAt: string;
  now?: number;
  maxAgeMs?: number;
  clockSkewMs?: number;
}): string[] {
  const installation = Date.parse(input.installationCreatedAt);
  const attestation = Date.parse(input.attestationCreatedAt);
  const run = Date.parse(input.runStartedAt);
  const now = input.now ?? Date.now();
  const maxAgeMs = input.maxAgeMs ?? 24 * 60 * 60_000;
  const clockSkewMs = input.clockSkewMs ?? 5 * 60_000;
  const errors: string[] = [];
  if (![installation, attestation, run].every(Number.isFinite)) {
    errors.push("installation, attestation, and run timestamps must all be valid ISO timestamps");
    return errors;
  }
  if (installation > attestation) errors.push("installation receipt must precede candidate attestation");
  if (attestation > run) errors.push("candidate attestation must precede the driver run");
  if (run - installation > maxAgeMs) errors.push("candidate installation evidence is stale for the final run");
  if (Math.max(installation, attestation, run) > now + clockSkewMs) errors.push("candidate evidence must not be future-dated");
  return errors;
}

function compareIdentity(
  errors: string[],
  label: string,
  actual: (ReleaseSurfaceFileIdentity & { path?: string }) | undefined,
  expected: ReleaseSurfaceFileIdentity & { path?: string },
  includePath: boolean,
): void {
  if (!actual || actual.basename !== expected.basename || actual.sha256 !== expected.sha256
    || actual.bytes !== expected.bytes || (includePath && actual.path !== expected.path)) {
    errors.push(`${label} identity does not match`);
  }
}

function joinPlatformPath(root: string, relativePath: string, platform: ReleasePlatform): string {
  const separator = platform === "windows-installed" ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${relativePath.replaceAll("/", separator)}`;
}

function samePlatformPath(left: string, right: string, platform: ReleasePlatform): boolean {
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "");
  const leftNormalized = normalize(left);
  const rightNormalized = normalize(right);
  return platform === "windows-installed"
    ? leftNormalized.toLowerCase() === rightNormalized.toLowerCase()
    : leftNormalized === rightNormalized;
}
