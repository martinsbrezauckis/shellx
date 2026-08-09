import type { ReleaseSurfaceFileIdentity } from "./release-surface-candidate-attestation";
import type { ReleaseSurfaceInstallationSystemEffect } from "./release-surface-installation-receipt";
import type { ReleaseSurfaceNativeSignatureVerification } from "./release-surface-signature-receipt";

type WindowsSignatureVerification = Extract<ReleaseSurfaceNativeSignatureVerification, { kind: "windows-authenticode" }>;

export const RELEASE_SURFACE_WINDOWS_NSIS_INSTALLATION_SCHEMA =
  "shellx/release-surface-windows-nsis-installation@1";

export interface ReleaseSurfaceWindowsNsisInstallationObservation {
  schema: typeof RELEASE_SURFACE_WINDOWS_NSIS_INSTALLATION_SCHEMA;
  collector: "windows-powershell-nsis-v1";
  orchestrator: "native" | "wsl";
  userName: string;
  userSid: string;
  userIsAdministrator: false;
  userIsAdministratorsMember: false;
  artifact: ReleaseSurfaceFileIdentity & {
    path: string;
    signatureStatus: "Valid";
    signerThumbprint: string;
    signerSubject: string;
    signerIssuer: string;
    timestampSubject: string;
    timestampIssuer: string;
    timestampThumbprint: string;
  };
  operation: {
    startedAt: string;
    completedAt: string;
    exitCode: 0;
    targetRootStateBefore: "absent";
    arguments: ["/S", "/NS", "/D=<redacted-run-owned-target>"];
  };
  targetRoot: string;
  mainExecutablePath: string;
  expectedVersion: string;
  webView2Identity: Array<{ scope: string; version: string }>;
  safety: {
    machineRegistrationsBefore: [];
    machineRegistrationsAfter: [];
    shellxProcessCountBefore: 0;
    shellxProcessCountAfter: 0;
    webView2IdentityUnchanged: true;
  };
  systemEffects: ReleaseSurfaceInstallationSystemEffect[];
}

export function windowsNsisPowerShellArguments(input: {
  scriptPath: string;
  artifactPath: string;
  targetRoot: string;
  expectedUser: string;
  expectedVersion: string;
  orchestrator: "native" | "wsl";
}): string[] {
  for (const [label, value] of Object.entries(input)) {
    if (typeof value !== "string" || !value.trim() || /[\r\n\0]/.test(value)) {
      throw new Error(`Windows NSIS ${label} is invalid`);
    }
  }
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", input.scriptPath,
    "-ArtifactPath", input.artifactPath,
    "-TargetRoot", input.targetRoot,
    "-ExpectedUser", input.expectedUser,
    "-ExpectedVersion", input.expectedVersion,
    "-Orchestrator", input.orchestrator,
  ];
}

export function validateReleaseSurfaceWindowsNsisInstallationObservation(input: {
  observation: ReleaseSurfaceWindowsNsisInstallationObservation;
  orchestrator: "native" | "wsl";
  expectedUser: string;
  expectedVersion: string;
  artifact: ReleaseSurfaceFileIdentity;
  artifactPath: string;
  targetRoot: string;
  approvedSignature: WindowsSignatureVerification;
}): string[] {
  const { observation, orchestrator, expectedUser, expectedVersion, artifact, artifactPath, targetRoot, approvedSignature } = input;
  const errors: string[] = [];
  if (observation.schema !== RELEASE_SURFACE_WINDOWS_NSIS_INSTALLATION_SCHEMA) {
    errors.push(`Windows NSIS observation schema must be ${RELEASE_SURFACE_WINDOWS_NSIS_INSTALLATION_SCHEMA}`);
  }
  if (observation.collector !== "windows-powershell-nsis-v1") errors.push("Windows NSIS collector is invalid");
  if (observation.orchestrator !== orchestrator) errors.push("Windows NSIS orchestrator does not match");
  if (observation.userName !== expectedUser || !/^S-1-5-(?:\d+-){1,14}\d+$/.test(observation.userSid ?? "")
    || observation.userIsAdministrator !== false || observation.userIsAdministratorsMember !== false) {
    errors.push("Windows NSIS observation does not bind the expected non-admin disposable user");
  }
  if (observation.expectedVersion !== expectedVersion) errors.push("Windows NSIS observed version does not match");
  if (!sameWindowsPath(observation.targetRoot, targetRoot)) errors.push("Windows NSIS target root does not match");
  if (!sameWindowsPath(observation.mainExecutablePath, `${targetRoot}\\shellx.exe`)) {
    errors.push("Windows NSIS main executable path does not match the target root");
  }
  if (!sameWindowsPath(observation.artifact?.path, artifactPath)
    || observation.artifact?.basename !== artifact.basename
    || observation.artifact?.sha256 !== artifact.sha256
    || observation.artifact?.bytes !== artifact.bytes) {
    errors.push("Windows NSIS observation does not bind the exact distribution artifact");
  }
  if (observation.artifact?.signatureStatus !== "Valid"
    || !/^[a-f0-9]{40,128}$/.test(observation.artifact?.signerThumbprint ?? "")) {
    errors.push("Windows NSIS observation requires a valid Authenticode signer thumbprint");
  }
  if (approvedSignature?.kind !== "windows-authenticode"
    || observation.artifact?.signerSubject !== approvedSignature.signerCertificate.subject
    || observation.artifact?.signerIssuer !== approvedSignature.signerCertificate.issuer
    || observation.artifact?.signerThumbprint !== approvedSignature.signerCertificate.thumbprint.toLowerCase()
    || observation.artifact?.timestampSubject !== approvedSignature.timestampCertificate.subject
    || observation.artifact?.timestampIssuer !== approvedSignature.timestampCertificate.issuer
    || observation.artifact?.timestampThumbprint !== approvedSignature.timestampCertificate.thumbprint.toLowerCase()) {
    errors.push("Windows NSIS Authenticode identity does not match the approved structured signing profile receipt");
  }
  const started = Date.parse(observation.operation?.startedAt);
  const completed = Date.parse(observation.operation?.completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) {
    errors.push("Windows NSIS operation timestamps are invalid or unordered");
  }
  if (observation.operation?.exitCode !== 0
    || observation.operation?.targetRootStateBefore !== "absent") {
    errors.push("Windows NSIS operation must prove an absent target and exit zero");
  }
  if (JSON.stringify(observation.operation?.arguments) !== JSON.stringify(["/S", "/NS", "/D=<redacted-run-owned-target>"])) {
    errors.push("Windows NSIS operation arguments are not the approved silent no-shortcut contract");
  }
  if (!Array.isArray(observation.webView2Identity) || observation.webView2Identity.length === 0
    || observation.webView2Identity.some((record) => !record.scope?.trim() || !record.version?.trim())) {
    errors.push("Windows NSIS observation must prove a stable pre-existing WebView2 identity");
  }
  if (!Array.isArray(observation.safety?.machineRegistrationsBefore)
    || observation.safety.machineRegistrationsBefore.length !== 0
    || !Array.isArray(observation.safety?.machineRegistrationsAfter)
    || observation.safety.machineRegistrationsAfter.length !== 0
    || observation.safety?.shellxProcessCountBefore !== 0
    || observation.safety?.shellxProcessCountAfter !== 0
    || observation.safety?.webView2IdentityUnchanged !== true) {
    errors.push("Windows NSIS observation does not prove the isolated process, registry, and WebView2 safety baseline");
  }
  if (!Array.isArray(observation.systemEffects)) errors.push("Windows NSIS observation system effects are missing");
  return errors;
}

function sameWindowsPath(left: string | undefined, right: string): boolean {
  const normalize = (value: string) => value.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
  return typeof left === "string" && normalize(left) === normalize(right);
}
