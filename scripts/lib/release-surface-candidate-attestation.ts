import { readFileSync } from "node:fs";
import type { ReleasePlatform } from "./release-surface-inventory";
import {
  validateReleaseSurfaceWindowsNativeRuntime,
  validateReleaseSurfaceWindowsObservationWindow,
  type ReleaseSurfaceWindowsNativeRuntime,
} from "./release-surface-windows-native-runtime";
import {
  validateReleaseSurfacePosixNativeRuntime,
  validateReleaseSurfacePosixObservationWindow,
  type ReleaseSurfacePosixNativeRuntime,
  type ReleaseSurfacePosixPlatform,
} from "./release-surface-posix-native-runtime";

export const RELEASE_SURFACE_CANDIDATE_ATTESTATION_SCHEMA =
  "shellx/release-surface-candidate-attestation@5";

export interface ReleaseSurfaceFileIdentity {
  basename: string;
  sha256: string;
  bytes: number;
}

export interface ReleaseSurfaceCandidateAttestation {
  schema: typeof RELEASE_SURFACE_CANDIDATE_ATTESTATION_SCHEMA;
  mode: "final-frozen-candidate";
  platform: ReleasePlatform;
  sourceCommit: string;
  version: string;
  createdAt: string;
  distributionArtifact: ReleaseSurfaceFileIdentity;
  installation: {
    method: "direct-artifact" | "installer-observed";
    sourceArtifactSha256: string;
    receipt: ReleaseSurfaceFileIdentity;
    payloadManifestSha256: string;
  };
  installedPayload: ReleaseSurfaceFileIdentity & { path: string };
  process: {
    pid: number;
    executablePath: string;
    executableSha256: string;
  };
  runtime: {
    debugBase: string;
    debugPort: number;
    debugTokenPath: string;
    mcpBase: string;
    mcpPort: number;
    mcpTokenPath: string;
    processId: number;
    instanceId: string;
    appVersion: string;
    buildCommit: string;
  };
  windowsNativeRuntime?: ReleaseSurfaceWindowsNativeRuntime;
  posixNativeRuntime?: ReleaseSurfacePosixNativeRuntime;
}

export function loadReleaseSurfaceCandidateAttestation(
  path: string,
): ReleaseSurfaceCandidateAttestation {
  return JSON.parse(readFileSync(path, "utf8")) as ReleaseSurfaceCandidateAttestation;
}

export function validateReleaseSurfaceCandidateAttestation(input: {
  attestation: ReleaseSurfaceCandidateAttestation;
  platform: ReleasePlatform;
  sourceCommit: string;
  version: string;
  artifact: ReleaseSurfaceFileIdentity;
  installationReceipt?: ReleaseSurfaceFileIdentity;
}): string[] {
  const { attestation, platform, sourceCommit, version, artifact, installationReceipt } = input;
  const errors: string[] = [];
  if (attestation.schema !== RELEASE_SURFACE_CANDIDATE_ATTESTATION_SCHEMA) {
    errors.push(`candidate attestation schema must be ${RELEASE_SURFACE_CANDIDATE_ATTESTATION_SCHEMA}`);
  }
  if (attestation.mode !== "final-frozen-candidate") errors.push("candidate attestation mode must be final-frozen-candidate");
  if (attestation.platform !== platform) errors.push(`candidate attestation platform must be ${platform}`);
  if (attestation.sourceCommit !== sourceCommit) errors.push("candidate attestation source commit does not match");
  if (attestation.version !== version) errors.push("candidate attestation version does not match");
  if (!validIso(attestation.createdAt)) errors.push("candidate attestation createdAt must be a valid ISO timestamp");
  compareFileIdentity(errors, "distribution artifact", attestation.distributionArtifact, artifact);

  const installation = attestation.installation;
  if (installation?.sourceArtifactSha256 !== artifact.sha256) {
    errors.push("candidate installation source artifact hash does not match the distribution artifact");
  }
  if (!installationReceipt) errors.push("candidate installation requires an exact installation receipt file");
  else compareFileIdentity(errors, "installation receipt", installation?.receipt, installationReceipt);
  if (!/^[a-f0-9]{64}$/.test(installation?.payloadManifestSha256 ?? "")) {
    errors.push("candidate installation payload manifest digest is invalid");
  }
  if (installation?.method === "direct-artifact") {
    if (attestation.installedPayload?.sha256 !== artifact.sha256) {
      errors.push("direct-artifact installed payload must be the exact distribution artifact bytes");
    }
  } else if (installation?.method === "installer-observed") {
    // The parsed receipt is validated independently against the installed payload.
  } else {
    errors.push("candidate installation method is unsupported");
  }

  validateFileIdentity(errors, "installed payload", attestation.installedPayload);
  if (!attestation.installedPayload?.path?.trim()) errors.push("installed payload path is required");
  if (!Number.isSafeInteger(attestation.process?.pid) || attestation.process.pid <= 0) {
    errors.push("candidate process pid must be a positive integer");
  }
  if (!attestation.process?.executablePath?.trim()) errors.push("candidate process executable path is required");
  if (!samePlatformPath(attestation.process?.executablePath, attestation.installedPayload?.path, platform)) {
    errors.push("candidate process image path does not match the installed payload path");
  }
  if (attestation.process?.executableSha256 !== attestation.installedPayload?.sha256) {
    errors.push("candidate process image hash does not match the installed payload hash");
  }
  if (attestation.runtime?.processId !== attestation.process?.pid) {
    errors.push("candidate runtime processId does not match the OS process pid");
  }
  if (!/^[a-zA-Z0-9._-]{16,128}$/.test(attestation.runtime?.instanceId ?? "")) {
    errors.push("candidate runtime instanceId must be a non-empty opaque run nonce");
  }
  if (!Number.isSafeInteger(attestation.runtime?.debugPort) || attestation.runtime.debugPort <= 0) {
    errors.push("candidate runtime debug port must be a positive integer");
  }
  if (!attestation.runtime?.debugTokenPath?.trim()) {
    errors.push("candidate runtime debug token path is required");
  }
  const parsedBase = parseExactReleaseSurfaceLoopbackBase(attestation.runtime?.debugBase);
  if (!parsedBase) errors.push("candidate runtime debugBase must be an exact http://127.0.0.1:<port> origin");
  if (parsedBase && Number(parsedBase.port) !== attestation.runtime.debugPort) {
    errors.push("candidate runtime debugBase port does not match debugPort");
  }
  if (!Number.isSafeInteger(attestation.runtime?.mcpPort) || attestation.runtime.mcpPort <= 0) {
    errors.push("candidate runtime MCP port must be a positive integer");
  }
  if (!attestation.runtime?.mcpTokenPath?.trim()) {
    errors.push("candidate runtime MCP token path is required");
  }
  const parsedMcpBase = parseExactReleaseSurfaceLoopbackBase(attestation.runtime?.mcpBase);
  if (!parsedMcpBase) errors.push("candidate runtime mcpBase must be an exact http://127.0.0.1:<port> origin");
  if (parsedMcpBase && Number(parsedMcpBase.port) !== attestation.runtime.mcpPort) {
    errors.push("candidate runtime mcpBase port does not match mcpPort");
  }
  if (attestation.runtime?.mcpPort === attestation.runtime?.debugPort) {
    errors.push("candidate runtime MCP and Debug API ports must be distinct");
  }
  if (attestation.runtime?.appVersion !== version) errors.push("candidate runtime app version does not match");
  if (attestation.runtime?.buildCommit !== sourceCommit) errors.push("candidate runtime build commit does not match");
  if (platform === "windows-installed") {
    if (attestation.posixNativeRuntime) {
      errors.push("POSIX native runtime evidence is not valid for a Windows candidate");
    }
    if (!attestation.windowsNativeRuntime) {
      errors.push("Windows candidate attestation requires native process and listener evidence");
    } else {
      errors.push(...validateReleaseSurfaceWindowsNativeRuntime(attestation.windowsNativeRuntime, {
        processId: attestation.process.pid,
        port: attestation.runtime.debugPort,
        imagePath: attestation.process.executablePath,
        imageSha256: attestation.process.executableSha256,
      }).map((error) => `Windows candidate runtime: ${error}`));
      if (attestation.windowsNativeRuntime.process.imageBytes !== attestation.installedPayload.bytes) {
        errors.push("Windows candidate runtime image bytes do not match the installed payload");
      }
      const nativeObservedAt = Date.parse(attestation.windowsNativeRuntime.observedAt);
      const createdAt = Date.parse(attestation.createdAt);
      if (Number.isFinite(nativeObservedAt) && Number.isFinite(createdAt)) {
        errors.push(...validateReleaseSurfaceWindowsObservationWindow(
          attestation.windowsNativeRuntime.observedAt,
          attestation.createdAt,
          "Windows native runtime observation",
        ));
      }
    }
  } else {
    if (attestation.windowsNativeRuntime) {
      errors.push("Windows native runtime evidence is not valid for a non-Windows candidate");
    }
    const posixPlatform = releaseSurfacePosixPlatform(platform);
    if (!attestation.posixNativeRuntime) {
      errors.push("Linux and macOS candidate attestations require native process and listener evidence");
    } else {
      errors.push(...validateReleaseSurfacePosixNativeRuntime(attestation.posixNativeRuntime, {
        platform: posixPlatform,
        processId: attestation.process.pid,
        port: attestation.runtime.debugPort,
        imagePath: attestation.process.executablePath,
        imageSha256: attestation.process.executableSha256,
      }).map((error) => `POSIX candidate runtime: ${error}`));
      if (attestation.posixNativeRuntime.process.imageBytes !== attestation.installedPayload.bytes) {
        errors.push("POSIX candidate runtime image bytes do not match the installed payload");
      }
      errors.push(...validateReleaseSurfacePosixObservationWindow(
        attestation.posixNativeRuntime.observedAt,
        attestation.createdAt,
        "POSIX native runtime observation",
      ));
    }
  }
  return errors;
}

export function releaseSurfacePosixPlatform(platform: ReleasePlatform): ReleaseSurfacePosixPlatform {
  if (platform === "linux-installed") return "linux";
  if (platform === "macos-installed") return "macos";
  throw new Error(`platform ${platform} is not POSIX`);
}

export function parseExactReleaseSurfaceDebugBase(value: string | undefined): URL | null {
  return parseExactReleaseSurfaceLoopbackBase(value);
}

export function parseExactReleaseSurfaceLoopbackBase(value: string | undefined): URL | null {
  if (!value || value.trim() !== value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) return null;
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    if (value !== url.origin && value !== `${url.origin}/`) return null;
    return url;
  } catch {
    return null;
  }
}

function validateFileIdentity(
  errors: string[],
  label: string,
  value: ReleaseSurfaceFileIdentity | undefined,
): void {
  if (!value?.basename?.trim()) errors.push(`${label} basename is required`);
  if (!/^[a-f0-9]{64}$/i.test(value?.sha256 ?? "")) errors.push(`${label} sha256 must be 64 hex characters`);
  if (!Number.isSafeInteger(value?.bytes) || (value?.bytes ?? 0) <= 0) errors.push(`${label} bytes must be a positive integer`);
}

function compareFileIdentity(
  errors: string[],
  label: string,
  actual: ReleaseSurfaceFileIdentity | undefined,
  expected: ReleaseSurfaceFileIdentity,
): void {
  validateFileIdentity(errors, label, actual);
  if (actual?.basename !== expected.basename || actual?.sha256 !== expected.sha256 || actual?.bytes !== expected.bytes) {
    errors.push(`${label} identity does not match the exact file`);
  }
}

function samePlatformPath(left: string | undefined, right: string | undefined, platform: ReleasePlatform): boolean {
  if (!left?.trim() || !right?.trim()) return false;
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "");
  const leftNormalized = normalize(left);
  const rightNormalized = normalize(right);
  return platform === "windows-installed"
    ? leftNormalized.toLowerCase() === rightNormalized.toLowerCase()
    : leftNormalized === rightNormalized;
}

function validIso(value: string | undefined): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
