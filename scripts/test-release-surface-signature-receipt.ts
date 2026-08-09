import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  RELEASE_SURFACE_MACOS_DEVELOPER_ID_AUTHORITY,
  RELEASE_SURFACE_SIGNATURE_RECEIPT_SCHEMA,
  validateReleaseSurfaceSignatureReceipt,
  type ReleaseSurfaceSignatureReceipt,
} from "./lib/release-surface-signature-receipt";

const artifact = { basename: "shellX_0.3.5_x64-setup.exe", sha256: "a".repeat(64), bytes: 123_456 };
const sourceCommit = "b".repeat(40);
const checks = ["authenticode-valid", "publisher-identity", "timestamp-valid"];
const windowsReceipt: ReleaseSurfaceSignatureReceipt = {
  schema: RELEASE_SURFACE_SIGNATURE_RECEIPT_SCHEMA,
  platform: "windows-installed",
  sourceCommit,
  version: "0.3.5",
  createdAt: "2026-07-28T17:50:00.000Z",
  artifact,
  status: "verified",
  nativeVerification: {
    kind: "windows-authenticode",
    collector: "windows-powershell-authenticode-v1",
    status: "Valid",
    verifiedAt: "2026-07-28T17:49:59.000Z",
    publisher: { commonName: "U1C", organization: "U1C", country: "LV" },
    verificationPolicy: {
      provider: "azure-artifact-signing",
      expectedEndpointHost: "fixture.codesigning.azure.net",
      expectedAccountName: "fixture-account",
      expectedProfileName: "fixture-profile",
      metadata: { basename: "shellx-artifact-signing-metadata.json", sha256: "c".repeat(64), bytes: 512 },
    },
    signerCertificate: certificate(
      "CN=U1C, O=U1C, L=Lielvarde, S=Ogres novads, C=LV",
      "CN=Microsoft ID Verified CS AOC CA 04, O=Microsoft Corporation, C=US",
      "d",
    ),
    timestampCertificate: certificate(
      "CN=Microsoft Public RSA Time Stamping Authority, O=Microsoft Corporation, C=US",
      "CN=Microsoft Public RSA Timestamping CA 2020, O=Microsoft Corporation, C=US",
      "e",
    ),
  },
  checks: checks.map((id) => ({ id, status: "pass", observed: `${id} was natively observed` })),
};
const validateWindows = (receipt: ReleaseSurfaceSignatureReceipt) => validateReleaseSurfaceSignatureReceipt({
  receipt,
  platform: "windows-installed",
  sourceCommit,
  version: "0.3.5",
  artifact,
  expectedStatus: "verified",
  requiredChecks: checks,
});
assert.deepEqual(validateWindows(windowsReceipt), []);

const alternatePrivateIdentity = structuredClone(windowsReceipt);
if (alternatePrivateIdentity.nativeVerification.kind !== "windows-authenticode") throw new Error("fixture kind drift");
alternatePrivateIdentity.nativeVerification.verificationPolicy.expectedAccountName = "alternate-private-account";
alternatePrivateIdentity.nativeVerification.verificationPolicy.expectedProfileName = "alternate-private-profile";
assert.deepEqual(validateWindows(alternatePrivateIdentity), []);
const wrongEndpointClass = structuredClone(windowsReceipt);
if (wrongEndpointClass.nativeVerification.kind !== "windows-authenticode") throw new Error("fixture kind drift");
wrongEndpointClass.nativeVerification.verificationPolicy.expectedEndpointHost = "example.invalid";
assert(validateWindows(wrongEndpointClass).some((error) => error.includes("Azure endpoint class")));
const wrongPublisher = structuredClone(windowsReceipt);
if (wrongPublisher.nativeVerification.kind !== "windows-authenticode") throw new Error("fixture kind drift");
wrongPublisher.nativeVerification.signerCertificate.subject = "CN=Someone Else, O=Someone Else, C=US";
assert(validateWindows(wrongPublisher).some((error) => error.includes("certificate identity")));
const absentTimestamp = structuredClone(windowsReceipt);
if (absentTimestamp.nativeVerification.kind !== "windows-authenticode") throw new Error("fixture kind drift");
absentTimestamp.nativeVerification.timestampCertificate.thumbprint = "bad";
assert(validateWindows(absentTimestamp).some((error) => error.includes("timestamp certificate")));

const linuxArtifact = { basename: "shellx.AppImage", sha256: "f".repeat(64), bytes: 99 };
const linuxReceipt: ReleaseSurfaceSignatureReceipt = {
  schema: RELEASE_SURFACE_SIGNATURE_RECEIPT_SCHEMA,
  platform: "linux-installed",
  sourceCommit,
  version: "0.3.5",
  createdAt: "2026-07-28T17:50:00.000Z",
  artifact: linuxArtifact,
  status: "digest-verified",
  nativeVerification: { kind: "artifact-digest", algorithm: "sha256", sha256: linuxArtifact.sha256 },
  checks: [{ id: "artifact-sha256-recomputed", status: "pass", observed: "exact digest recomputed" }],
};
assert.deepEqual(validateReleaseSurfaceSignatureReceipt({
  receipt: linuxReceipt,
  platform: "linux-installed",
  sourceCommit,
  version: "0.3.5",
  artifact: linuxArtifact,
  expectedStatus: "digest-verified",
  requiredChecks: ["artifact-sha256-recomputed"],
}), []);

const macosArtifact = { basename: "shellX_0.3.5_aarch64.dmg", sha256: "9".repeat(64), bytes: 987_654 };
const macosChecks = ["codesign-deep-strict", "gatekeeper-assess", "notary-staple"];
const macosReceipt: ReleaseSurfaceSignatureReceipt = {
  schema: RELEASE_SURFACE_SIGNATURE_RECEIPT_SCHEMA,
  platform: "macos-installed",
  sourceCommit,
  version: "0.3.5",
  createdAt: "2026-07-28T17:50:00.000Z",
  artifact: macosArtifact,
  status: "verified",
  nativeVerification: {
    kind: "macos-codesign",
    collector: "macos-native-signature-v1",
    verifiedAt: "2026-07-28T17:49:59.000Z",
    artifact: macosArtifact,
    mountedImage: {
      deviceEntry: "/dev/disk7s1",
      mountPoint: "/private/tmp/shellx-final-signature-fixture/shellX",
      volumeName: "shellX",
      mountedAt: "2026-07-28T17:49:50.000Z",
      detachedAt: "2026-07-28T17:50:00.000Z",
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
      executable: { basename: "shellX", sha256: "8".repeat(64), bytes: 123_456 },
      authorities: [
        RELEASE_SURFACE_MACOS_DEVELOPER_ID_AUTHORITY,
        "Developer ID Certification Authority",
        "Apple Root CA",
      ],
      designatedRequirement: 'designated => identifier "lv.shellx.app" and anchor apple generic and certificate leaf[subject.OU] = "4M329JW6R4"',
      secureTimestamp: true,
      hardenedRuntime: true,
    },
    codesign: { status: "accepted", deep: true, strict: true, allArchitectures: true },
    gatekeeper: { status: "accepted", assessmentType: "execute", source: "Notarized Developer ID" },
    stapler: { application: "validated", diskImage: "validated" },
  },
  checks: macosChecks.map((id) => ({ id, status: "pass", observed: `${id} was natively observed` })),
};
const validateMacos = (receipt: ReleaseSurfaceSignatureReceipt) => validateReleaseSurfaceSignatureReceipt({
  receipt,
  platform: "macos-installed",
  sourceCommit,
  version: "0.3.5",
  artifact: macosArtifact,
  expectedStatus: "verified",
  requiredChecks: macosChecks,
});
assert.deepEqual(validateMacos(macosReceipt), []);
const wrongMacTeam = structuredClone(macosReceipt);
if (wrongMacTeam.nativeVerification.kind !== "macos-codesign") throw new Error("fixture kind drift");
wrongMacTeam.nativeVerification.application.teamId = "ABCDE12345" as "4M329JW6R4";
assert(validateMacos(wrongMacTeam).some((error) => error.includes("frozen ShellX bundle policy")));
const detachedBeforeMount = structuredClone(macosReceipt);
if (detachedBeforeMount.nativeVerification.kind !== "macos-codesign") throw new Error("fixture kind drift");
detachedBeforeMount.nativeVerification.mountedImage.detachedAt = "2026-07-28T17:40:00.000Z";
assert(validateMacos(detachedBeforeMount).some((error) => error.includes("mounted-image identity")));
const missingDmgTicket = structuredClone(macosReceipt);
if (missingDmgTicket.nativeVerification.kind !== "macos-codesign") throw new Error("fixture kind drift");
missingDmgTicket.nativeVerification.stapler.diskImage = "missing" as "validated";
assert(validateMacos(missingDmgTicket).some((error) => error.includes("both the application and exact DMG")));

const collectorSource = readFileSync(resolve(import.meta.dirname, "collect-release-surface-windows-authenticode.ps1"), "utf8");
assert(collectorSource.includes("Get-AuthenticodeSignature"));
assert(collectorSource.includes("TimeStamperCertificate"));
assert(collectorSource.includes("ExpectedPublisherCommonName"));
assert(collectorSource.includes("ExpectedIssuerOrganization"));
assert(collectorSource.includes("[IO.DriveInfo]::new"));
assert(collectorSource.includes("subst.exe"));
assert(!collectorSource.includes("Get-CimInstance"));
const creatorSource = readFileSync(resolve(import.meta.dirname, "create-release-surface-windows-signature-receipt.ts"), "utf8");
assert(creatorSource.includes('"-VerifyOnly"'));
assert(creatorSource.includes("windows-signing-profile.json"));
assert(creatorSource.includes("Azure signing metadata is incomplete or outside the expected endpoint class"));
assert(creatorSource.includes("privateSigningIdentity.endpointHost"));
assert(creatorSource.includes("privateSigningIdentity.accountName"));
assert(creatorSource.includes("privateSigningIdentity.profileName"));

console.log("Release surface structured signature receipt tests passed");

function certificate(subject: string, issuer: string, fill: string) {
  return {
    subject,
    issuer,
    thumbprint: fill.repeat(40),
    serialNumber: fill.repeat(16),
    notBefore: "2026-07-01T00:00:00.000Z",
    notAfter: "2026-08-01T00:00:00.000Z",
  };
}
