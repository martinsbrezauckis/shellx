import { readFileSync } from "node:fs";
import type { ReleasePlatform } from "./release-surface-inventory";
import type { ReleaseSurfaceFileIdentity } from "./release-surface-candidate-attestation";

export const RELEASE_SURFACE_SIGNATURE_RECEIPT_SCHEMA = "shellx/release-surface-signature-receipt@2";
export const RELEASE_SURFACE_MACOS_TEAM_ID = "4M329JW6R4";
export const RELEASE_SURFACE_MACOS_BUNDLE_ID = "lv.shellx.app";
export const RELEASE_SURFACE_MACOS_APP_BASENAME = "shellX.app";
export const RELEASE_SURFACE_MACOS_DEVELOPER_ID_AUTHORITY =
  "Developer ID Application: Martins Brezauckis (4M329JW6R4)";

interface FrozenWindowsSigningProfile {
  schema: "shellx/windows-signing-profile@2";
  publisher: { commonName: string; organization: string; country: string };
  issuerOrganization: string;
  timestampIssuerOrganization: string;
}

const WINDOWS_SIGNING_PROFILE = JSON.parse(readFileSync(
  new URL("../../release/windows-signing-profile.json", import.meta.url),
  "utf8",
)) as FrozenWindowsSigningProfile;

export interface ReleaseSurfaceCertificateIdentity {
  subject: string;
  issuer: string;
  thumbprint: string;
  serialNumber: string;
  notBefore: string;
  notAfter: string;
}

export type ReleaseSurfaceNativeSignatureVerification =
  | {
    kind: "windows-authenticode";
    collector: "windows-powershell-authenticode-v1";
    status: "Valid";
    verifiedAt: string;
    publisher: { commonName: string; organization: string; country: string };
    verificationPolicy: {
      provider: "azure-artifact-signing";
      expectedEndpointHost: string;
      expectedAccountName: string;
      expectedProfileName: string;
      metadata: ReleaseSurfaceFileIdentity;
    };
    signerCertificate: ReleaseSurfaceCertificateIdentity;
    timestampCertificate: ReleaseSurfaceCertificateIdentity;
  }
  | {
    kind: "macos-codesign";
    collector: "macos-native-signature-v1";
    verifiedAt: string;
    artifact: ReleaseSurfaceFileIdentity;
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
    };
    application: {
      relativePath: typeof RELEASE_SURFACE_MACOS_APP_BASENAME;
      bundleId: typeof RELEASE_SURFACE_MACOS_BUNDLE_ID;
      teamId: typeof RELEASE_SURFACE_MACOS_TEAM_ID;
      executableRelativePath: string;
      executable: ReleaseSurfaceFileIdentity;
      authorities: string[];
      designatedRequirement: string;
      secureTimestamp: true;
      hardenedRuntime: true;
    };
    codesign: {
      status: "accepted";
      deep: true;
      strict: true;
      allArchitectures: true;
    };
    gatekeeper: {
      status: "accepted";
      assessmentType: "execute";
      source: "Notarized Developer ID";
    };
    stapler: {
      application: "validated";
      diskImage: "validated";
    };
  }
  | { kind: "artifact-digest"; algorithm: "sha256"; sha256: string };

export interface ReleaseSurfaceSignatureReceipt {
  schema: typeof RELEASE_SURFACE_SIGNATURE_RECEIPT_SCHEMA;
  platform: ReleasePlatform;
  sourceCommit: string;
  version: string;
  createdAt: string;
  artifact: {
    basename: string;
    sha256: string;
    bytes: number;
  };
  status: "verified" | "digest-verified";
  nativeVerification: ReleaseSurfaceNativeSignatureVerification;
  checks: Array<{
    id: string;
    status: "pass" | "fail";
    observed: string;
  }>;
}

export function loadReleaseSurfaceSignatureReceipt(path: string): ReleaseSurfaceSignatureReceipt {
  return JSON.parse(readFileSync(path, "utf8")) as ReleaseSurfaceSignatureReceipt;
}

export function validateReleaseSurfaceSignatureReceipt(input: {
  receipt: ReleaseSurfaceSignatureReceipt;
  platform: ReleasePlatform;
  sourceCommit: string;
  version: string;
  artifact: { basename: string; sha256: string; bytes: number };
  expectedStatus: "verified" | "digest-verified";
  requiredChecks: string[];
}): string[] {
  const { receipt, platform, sourceCommit, version, artifact, expectedStatus, requiredChecks } = input;
  const errors: string[] = [];
  if (receipt.schema !== RELEASE_SURFACE_SIGNATURE_RECEIPT_SCHEMA) {
    errors.push(`signature receipt schema must be ${RELEASE_SURFACE_SIGNATURE_RECEIPT_SCHEMA}`);
  }
  for (const [field, expected, actual] of [
    ["platform", platform, receipt.platform],
    ["sourceCommit", sourceCommit, receipt.sourceCommit],
    ["version", version, receipt.version],
    ["artifact basename", artifact.basename, receipt.artifact?.basename],
    ["artifact sha256", artifact.sha256, receipt.artifact?.sha256],
    ["artifact bytes", artifact.bytes, receipt.artifact?.bytes],
    ["status", expectedStatus, receipt.status],
  ] as const) {
    if (actual !== expected) errors.push(`signature receipt ${field} must match the exact frozen artifact`);
  }
  if (!Number.isFinite(Date.parse(receipt.createdAt))) errors.push("signature receipt createdAt must be a valid ISO timestamp");
  const byId = new Map<string, ReleaseSurfaceSignatureReceipt["checks"][number]>();
  for (const check of receipt.checks ?? []) {
    if (byId.has(check.id)) errors.push(`signature check ${check.id} appears more than once`);
    else byId.set(check.id, check);
  }
  for (const id of requiredChecks) {
    const check = byId.get(id);
    if (!check) {
      errors.push(`required signature check ${id} is missing`);
      continue;
    }
    if (check.status !== "pass") errors.push(`signature check ${id} must pass`);
    if (!check.observed?.trim()) errors.push(`signature check ${id} must describe the native verification result`);
  }
  for (const id of byId.keys()) {
    if (!requiredChecks.includes(id)) errors.push(`signature check ${id} is not declared in the final contract`);
  }
  errors.push(...validateReleaseSurfaceNativeSignatureVerification({
    native: receipt.nativeVerification,
    platform,
    artifact,
  }));
  return errors;
}

export function validateReleaseSurfaceNativeSignatureVerification(input: {
  native: ReleaseSurfaceNativeSignatureVerification;
  platform: ReleasePlatform;
  artifact: { sha256: string };
}): string[] {
  const { native, platform, artifact } = input;
  const errors: string[] = [];
  if (platform === "windows-installed") {
    if (native?.kind !== "windows-authenticode") {
      errors.push("Windows signature receipt requires structured native Authenticode verification");
      return errors;
    }
    if (native.collector !== "windows-powershell-authenticode-v1" || native.status !== "Valid"
      || !Number.isFinite(Date.parse(native.verifiedAt))) {
      errors.push("Windows native Authenticode verification provenance is invalid");
    }
    if (!native.publisher?.commonName?.trim() || !native.publisher?.organization?.trim()
      || !/^[A-Z]{2}$/.test(native.publisher?.country ?? "")) {
      errors.push("Windows native publisher identity is incomplete");
    }
    if (native.verificationPolicy?.provider !== "azure-artifact-signing"
      || !native.verificationPolicy?.expectedEndpointHost?.trim() || !native.verificationPolicy?.expectedAccountName?.trim()
      || !native.verificationPolicy?.expectedProfileName?.trim()
      || !validFileIdentity(native.verificationPolicy?.metadata)) {
      errors.push("Windows native Azure verification-policy evidence is incomplete");
    }
    if (WINDOWS_SIGNING_PROFILE.schema !== "shellx/windows-signing-profile@2"
      || JSON.stringify(native.publisher) !== JSON.stringify(WINDOWS_SIGNING_PROFILE.publisher)
      || !native.verificationPolicy?.expectedEndpointHost?.endsWith(".codesigning.azure.net")) {
      errors.push("Windows signature receipt does not match the frozen ShellX publisher policy or Azure endpoint class");
    }
    validateCertificate(errors, "Windows signer", native.signerCertificate);
    validateCertificate(errors, "Windows timestamp", native.timestampCertificate);
    if (dnValue(native.signerCertificate?.subject, "CN") !== WINDOWS_SIGNING_PROFILE.publisher.commonName
      || dnValue(native.signerCertificate?.subject, "O") !== WINDOWS_SIGNING_PROFILE.publisher.organization
      || dnValue(native.signerCertificate?.subject, "C") !== WINDOWS_SIGNING_PROFILE.publisher.country
      || dnValue(native.signerCertificate?.issuer, "O") !== WINDOWS_SIGNING_PROFILE.issuerOrganization
      || dnValue(native.timestampCertificate?.issuer, "O") !== WINDOWS_SIGNING_PROFILE.timestampIssuerOrganization) {
      errors.push("Windows signer or timestamp certificate identity does not match the frozen publisher and issuer policy");
    }
    return errors;
  }
  if (platform === "macos-installed") {
    if (native?.kind !== "macos-codesign") {
      errors.push("macOS signature receipt requires structured code-sign, Gatekeeper, notarization, and staple evidence");
      return errors;
    }
    if (native.collector !== "macos-native-signature-v1" || !Number.isFinite(Date.parse(native.verifiedAt))) {
      errors.push("macOS native signature verification provenance is invalid");
    }
    if (!validFileIdentity(native.artifact)
      || native.artifact.sha256 !== artifact.sha256) {
      errors.push("macOS native signature verification does not bind the exact DMG bytes");
    }
    const mounted = native.mountedImage;
    const mountedAt = Date.parse(mounted?.mountedAt);
    const detachedAt = Date.parse(mounted?.detachedAt);
    const verifiedAt = Date.parse(native.verifiedAt);
    if (!/^\/dev\/disk\d+(?:s\d+)?$/.test(mounted?.deviceEntry ?? "")
      || !validCanonicalPosixPath(mounted?.mountPoint)
      || !mounted?.volumeName?.trim()
      || !Number.isFinite(mountedAt) || !Number.isFinite(detachedAt) || !Number.isFinite(verifiedAt)
      || verifiedAt < mountedAt || detachedAt < verifiedAt
      || mounted?.readOnly !== true || mounted?.noBrowse !== true || mounted?.noAutoOpen !== true
      || mounted?.detached !== true) {
      errors.push("macOS mounted-image identity or safe detach evidence is incomplete");
    }
    const application = native.application;
    if (application?.relativePath !== RELEASE_SURFACE_MACOS_APP_BASENAME
      || application?.bundleId !== RELEASE_SURFACE_MACOS_BUNDLE_ID
      || application?.teamId !== RELEASE_SURFACE_MACOS_TEAM_ID
      || !validMacosExecutableRelativePath(application?.executableRelativePath)
      || !validFileIdentity(application?.executable)
      || application?.executable?.basename !== application?.executableRelativePath?.split("/").at(-1)) {
      errors.push("macOS mounted application identity does not match the frozen ShellX bundle policy");
    }
    if (!Array.isArray(application?.authorities)
      || !application.authorities.includes(RELEASE_SURFACE_MACOS_DEVELOPER_ID_AUTHORITY)
      || !application.designatedRequirement?.includes(`identifier \"${RELEASE_SURFACE_MACOS_BUNDLE_ID}\"`)
      || !application.designatedRequirement?.includes(`subject.OU] = \"${RELEASE_SURFACE_MACOS_TEAM_ID}\"`)
      || application.secureTimestamp !== true || application.hardenedRuntime !== true) {
      errors.push("macOS Developer ID authority, designated requirement, timestamp, or hardened runtime is invalid");
    }
    if (native.codesign?.status !== "accepted" || native.codesign?.deep !== true
      || native.codesign?.strict !== true || native.codesign?.allArchitectures !== true) {
      errors.push("macOS codesign evidence must prove deep strict all-architecture acceptance");
    }
    if (native.gatekeeper?.status !== "accepted" || native.gatekeeper?.assessmentType !== "execute"
      || native.gatekeeper?.source !== "Notarized Developer ID") {
      errors.push("macOS Gatekeeper must accept the app as a Notarized Developer ID application");
    }
    if (native.stapler?.application !== "validated" || native.stapler?.diskImage !== "validated") {
      errors.push("macOS stapler must validate tickets on both the application and exact DMG");
    }
    return errors;
  }
  if (native?.kind !== "artifact-digest" || native.algorithm !== "sha256" || native.sha256 !== artifact.sha256) {
    errors.push("Linux signature receipt requires structured exact artifact digest evidence");
  }
  return errors;
}

function validateCertificate(
  errors: string[],
  label: string,
  certificate: ReleaseSurfaceCertificateIdentity | undefined,
): void {
  if (!certificate?.subject?.trim() || !certificate.issuer?.trim()
    || !/^[a-f0-9]{40,128}$/i.test(certificate.thumbprint ?? "")
    || !/^[a-f0-9]+$/i.test(certificate.serialNumber ?? "")
    || !Number.isFinite(Date.parse(certificate.notBefore))
    || !Number.isFinite(Date.parse(certificate.notAfter))) {
    errors.push(`${label} certificate identity is incomplete`);
  }
}

function validFileIdentity(identity: ReleaseSurfaceFileIdentity | undefined): boolean {
  return Boolean(identity?.basename?.trim() && /^[a-f0-9]{64}$/.test(identity.sha256)
    && Number.isSafeInteger(identity.bytes) && identity.bytes > 0);
}

function validCanonicalPosixPath(value: string | undefined): boolean {
  return Boolean(value?.startsWith("/") && value !== "/" && value === value.trim()
    && !value.includes("\\") && !value.includes("//") && !value.endsWith("/")
    && !value.slice(1).split("/").some((part) => !part || part === "." || part === ".."));
}

function validMacosExecutableRelativePath(value: string | undefined): boolean {
  if (!value?.startsWith(`${RELEASE_SURFACE_MACOS_APP_BASENAME}/Contents/MacOS/`)
    || value.includes("\\") || value.startsWith("/") || value.includes("\0")) return false;
  return !value.split("/").some((part) => !part || part === "." || part === "..");
}

function dnValue(value: string | undefined, name: string): string {
  if (!value) return "";
  const match = value.match(new RegExp(`(?:^|,\\s*)${name}=([^,]+)`, "i"));
  return match?.[1]?.trim() ?? "";
}
