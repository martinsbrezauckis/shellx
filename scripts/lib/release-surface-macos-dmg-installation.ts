import { createHash } from "node:crypto";
import { lstatSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ReleaseSurfaceFileIdentity } from "./release-surface-candidate-attestation";
import type { ReleaseSurfaceInstallationSystemEffect } from "./release-surface-installation-receipt";
import {
  validateReleaseSurfaceInstalledPayloadManifest,
  type ReleaseSurfaceInstalledPayloadManifest,
} from "./release-surface-installed-payload-manifest";
import {
  RELEASE_SURFACE_MACOS_APP_BASENAME,
  type ReleaseSurfaceNativeSignatureVerification,
} from "./release-surface-signature-receipt";

type MacosSignatureVerification = Extract<ReleaseSurfaceNativeSignatureVerification, { kind: "macos-codesign" }>;

export const RELEASE_SURFACE_MACOS_DMG_INSTALLATION_SCHEMA =
  "shellx/release-surface-macos-dmg-installation@1";

export interface ReleaseSurfaceMacosDmgInstallationObservation {
  schema: typeof RELEASE_SURFACE_MACOS_DMG_INSTALLATION_SCHEMA;
  collector: "macos-native-dmg-install-v1";
  artifact: ReleaseSurfaceFileIdentity & { path: string };
  operation: {
    startedAt: string;
    completedAt: string;
    exitCode: 0;
    targetRootStateBefore: "absent";
    arguments: ["attach-readonly-nobrowse-noautoopen", "ditto-copy-without-launch", "detach-exact-device"];
  };
  mountedImage: {
    deviceEntry: string;
    mountPoint: string;
    volumeName: string;
    mountedAt: string;
    detachedAt: string;
    readOnly: true;
    noBrowse: true;
    noAutoOpen: true;
    detached: true;
    sourceApplicationRelativePath: typeof RELEASE_SURFACE_MACOS_APP_BASENAME;
  };
  sourceApplication: {
    executableRelativePath: string;
    executable: ReleaseSurfaceFileIdentity;
    payloadTreeSha256: string;
    entryCount: number;
    totalFileBytes: number;
  };
  targetApplication: {
    path: string;
    stateBefore: "absent";
    createdWithoutOverwrite: true;
    ownerUid: number;
    executableRelativePath: string;
    executable: ReleaseSurfaceFileIdentity;
    payloadTreeSha256: string;
    entryCount: number;
    totalFileBytes: number;
    codesignVerified: true;
    gatekeeperAccepted: true;
  };
  safety: {
    shellxProcessIdsBefore: [];
    shellxProcessIdsAfter: [];
    launchRequested: false;
  };
  systemEffects: ReleaseSurfaceInstallationSystemEffect[];
}

export function releaseSurfaceMacosPayloadTreeDigest(manifest: ReleaseSurfaceInstalledPayloadManifest): string {
  return createHash("sha256").update(JSON.stringify({
    mainExecutableRelativePath: manifest.mainExecutableRelativePath,
    entries: manifest.entries,
  })).digest("hex");
}

export function removeReleaseSurfaceMacosManifestBoundTree(input: {
  targetApp: string;
  manifest: ReleaseSurfaceInstalledPayloadManifest;
}): void {
  const targetApp = resolve(input.targetApp);
  const manifestErrors = validateReleaseSurfaceInstalledPayloadManifest(input.manifest);
  if (manifestErrors.length > 0) {
    throw new Error(`macOS finalization manifest is invalid: ${manifestErrors.join("; ")}`);
  }
  if (input.manifest.platform !== "macos-installed" || input.manifest.scope !== "installer-target-root"
    || input.manifest.rootPath !== targetApp
    || !/^shellx-final-install-[A-Za-z0-9._-]+\.app$/.test(basename(targetApp))) {
    throw new Error("macOS finalization manifest does not bind the exact target application");
  }
  const entries = [...input.manifest.entries].sort((left, right) => {
    const depth = right.path.split("/").length - left.path.split("/").length;
    if (depth !== 0) return depth;
    if (left.kind !== right.kind) return left.kind === "file" ? -1 : 1;
    return right.path.localeCompare(left.path);
  });
  for (const entry of entries) {
    const path = join(targetApp, ...entry.path.split("/"));
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`macOS finalization refuses a changed link at ${entry.path}`);
    if (entry.kind === "file") {
      if (!stat.isFile() || stat.size !== entry.bytes) throw new Error(`macOS finalization file identity changed at ${entry.path}`);
      const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
      if (sha256 !== entry.sha256) throw new Error(`macOS finalization file hash changed at ${entry.path}`);
    } else {
      if (!stat.isDirectory()) throw new Error(`macOS finalization directory identity changed at ${entry.path}`);
    }
  }
  const targetStat = lstatSync(targetApp);
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory() || basename(targetApp) === "") {
    throw new Error("macOS finalization target application identity changed");
  }
  for (const entry of entries) {
    const path = join(targetApp, ...entry.path.split("/"));
    if (entry.kind === "file") unlinkSync(path);
    else rmdirSync(path);
  }
  rmdirSync(targetApp);
}

export function validateReleaseSurfaceMacosDmgInstallationObservation(input: {
  observation: ReleaseSurfaceMacosDmgInstallationObservation;
  artifact: ReleaseSurfaceFileIdentity;
  artifactPath: string;
  targetApp: string;
  approvedSignature: MacosSignatureVerification;
  targetManifest: ReleaseSurfaceInstalledPayloadManifest;
}): string[] {
  const { observation, artifact, artifactPath, targetApp, approvedSignature, targetManifest } = input;
  const errors: string[] = [];
  if (observation.schema !== RELEASE_SURFACE_MACOS_DMG_INSTALLATION_SCHEMA) {
    errors.push(`macOS DMG observation schema must be ${RELEASE_SURFACE_MACOS_DMG_INSTALLATION_SCHEMA}`);
  }
  if (observation.collector !== "macos-native-dmg-install-v1") errors.push("macOS DMG collector is invalid");
  if (observation.artifact?.path !== artifactPath
    || !sameIdentity(observation.artifact, artifact)) {
    errors.push("macOS DMG observation does not bind the exact distribution artifact");
  }
  if (approvedSignature?.kind !== "macos-codesign"
    || !sameIdentity(approvedSignature.artifact, artifact)) {
    errors.push("macOS DMG observation requires exact approved signature evidence");
  }
  const operation = observation.operation;
  const started = Date.parse(operation?.startedAt);
  const completed = Date.parse(operation?.completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started
    || operation?.exitCode !== 0 || operation?.targetRootStateBefore !== "absent"
    || JSON.stringify(operation?.arguments) !== JSON.stringify([
      "attach-readonly-nobrowse-noautoopen", "ditto-copy-without-launch", "detach-exact-device",
    ])) {
    errors.push("macOS DMG operation does not prove the approved copy-only lifecycle");
  }
  const image = observation.mountedImage;
  const mountedAt = Date.parse(image?.mountedAt);
  const detachedAt = Date.parse(image?.detachedAt);
  if (!/^\/dev\/disk\d+(?:s\d+)?$/.test(image?.deviceEntry ?? "")
    || !canonicalPosixPath(image?.mountPoint) || !image?.volumeName?.trim()
    || !Number.isFinite(mountedAt) || !Number.isFinite(detachedAt)
    || mountedAt < started || detachedAt < mountedAt || detachedAt !== completed
    || image?.readOnly !== true || image?.noBrowse !== true || image?.noAutoOpen !== true
    || image?.detached !== true || image?.sourceApplicationRelativePath !== RELEASE_SURFACE_MACOS_APP_BASENAME) {
    errors.push("macOS DMG mounted-image identity or exact detach evidence is incomplete");
  }
  const source = observation.sourceApplication;
  const target = observation.targetApplication;
  const expectedTargetExecutable = typeof source?.executableRelativePath === "string"
    ? source.executableRelativePath.replace(`${RELEASE_SURFACE_MACOS_APP_BASENAME}/`, "")
    : "";
  if (source?.executableRelativePath !== approvedSignature?.application.executableRelativePath
    || !sameIdentity(source?.executable, approvedSignature?.application.executable)) {
    errors.push("macOS DMG mounted app executable does not match approved signature evidence");
  }
  if (target?.path !== targetApp || target?.stateBefore !== "absent" || target?.createdWithoutOverwrite !== true
    || !Number.isSafeInteger(target?.ownerUid) || target.ownerUid < 0
    || target?.executableRelativePath !== expectedTargetExecutable
    || !sameIdentity(target?.executable, source?.executable)
    || target?.codesignVerified !== true || target?.gatekeeperAccepted !== true) {
    errors.push("macOS DMG copied application target does not bind the exact mounted app");
  }
  const expectedTreeSha = releaseSurfaceMacosPayloadTreeDigest(targetManifest);
  if (!/^[a-f0-9]{64}$/.test(source?.payloadTreeSha256 ?? "")
    || source?.payloadTreeSha256 !== target?.payloadTreeSha256
    || target?.payloadTreeSha256 !== expectedTreeSha
    || source?.entryCount !== targetManifest.entryCount || target?.entryCount !== targetManifest.entryCount
    || source?.totalFileBytes !== targetManifest.totalFileBytes
    || target?.totalFileBytes !== targetManifest.totalFileBytes) {
    errors.push("macOS DMG copy does not match the complete installed application manifest");
  }
  if (!Array.isArray(observation.safety?.shellxProcessIdsBefore)
    || observation.safety.shellxProcessIdsBefore.length !== 0
    || !Array.isArray(observation.safety?.shellxProcessIdsAfter)
    || observation.safety.shellxProcessIdsAfter.length !== 0
    || observation.safety?.launchRequested !== false) {
    errors.push("macOS DMG installation did not prove a zero-process no-autolaunch baseline");
  }
  validateSystemEffects(errors, observation.systemEffects, targetApp, image?.deviceEntry);
  return errors;
}

function validateSystemEffects(
  errors: string[],
  effects: ReleaseSurfaceInstallationSystemEffect[] | undefined,
  targetApp: string,
  deviceEntry: string | undefined,
): void {
  if (!Array.isArray(effects)) {
    errors.push("macOS DMG system effects are missing");
    return;
  }
  const byId = new Map(effects.map((effect) => [effect.id, effect]));
  if (byId.size !== effects.length) errors.push("macOS DMG system-effect ids must be unique");
  const required = ["macos-app-bundle-copy", "macos-disk-image-lifecycle", "macos-autolaunch-suppressed"];
  for (const effect of effects) {
    if (!required.includes(effect.id)) errors.push(`macOS DMG system effect ${effect.id} is not declared`);
    if (effect.status !== "pass" || !effect.observed?.trim()
      || !effect.details || typeof effect.details !== "object" || Array.isArray(effect.details)) {
      errors.push(`macOS DMG system effect ${effect.id} is incomplete`);
    }
  }
  for (const id of required) if (!byId.has(id)) errors.push(`macOS DMG system effects are missing ${id}`);
  const copy = byId.get("macos-app-bundle-copy")?.details;
  if (copy?.targetApp !== targetApp || copy?.sourceApp !== RELEASE_SURFACE_MACOS_APP_BASENAME
    || copy?.copyTool !== "/usr/bin/ditto" || copy?.overwriteAllowed !== false) {
    errors.push("macOS app-bundle copy effect does not bind the exact source and target");
  }
  const image = byId.get("macos-disk-image-lifecycle")?.details;
  if (image?.deviceEntry !== deviceEntry || image?.readOnly !== true || image?.detached !== true) {
    errors.push("macOS disk-image lifecycle effect does not bind the exact read-only mount");
  }
  const launch = byId.get("macos-autolaunch-suppressed")?.details;
  if (launch?.launchRequested !== false || launch?.processesBefore !== 0 || launch?.processesAfter !== 0) {
    errors.push("macOS autolaunch suppression effect is incomplete");
  }
}

function sameIdentity(
  left: ReleaseSurfaceFileIdentity | undefined,
  right: ReleaseSurfaceFileIdentity | undefined,
): boolean {
  return Boolean(left && right && left.basename === right.basename && left.sha256 === right.sha256 && left.bytes === right.bytes);
}

function canonicalPosixPath(value: string | undefined): boolean {
  return Boolean(value?.startsWith("/") && value !== "/" && value === value.trim()
    && !value.includes("\\") && !value.includes("//") && !value.endsWith("/")
    && !value.slice(1).split("/").some((part) => !part || part === "." || part === ".."));
}
