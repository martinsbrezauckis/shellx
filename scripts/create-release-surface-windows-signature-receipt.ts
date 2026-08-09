import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import {
  RELEASE_SURFACE_SIGNATURE_RECEIPT_SCHEMA,
  validateReleaseSurfaceSignatureReceipt,
  type ReleaseSurfaceCertificateIdentity,
  type ReleaseSurfaceSignatureReceipt,
} from "./lib/release-surface-signature-receipt";

interface WindowsSigningProfile {
  schema: "shellx/windows-signing-profile@2";
  publisher: { commonName: string; organization: string; country: string };
  issuerOrganization: string;
  timestampIssuerOrganization: string;
}

interface WindowsAuthenticodeObservation {
  schema: "shellx/release-surface-windows-authenticode-observation@1";
  collector: "windows-powershell-authenticode-v1";
  status: "Valid";
  verifiedAt: string;
  artifactPath: string;
  artifactSha256: string;
  artifactBytes: number;
  publisher: WindowsSigningProfile["publisher"];
  signerCertificate: ReleaseSurfaceCertificateIdentity;
  timestampCertificate: ReleaseSurfaceCertificateIdentity;
}

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
assertWindowsHost();
const artifactPath = requiredArg(args, "--artifact");
const metadataInputPath = requiredArg(args, "--signing-metadata");
const outputPath = resolve(requiredArg(args, "--out"));
assertCanonicalWindowsPath(artifactPath, "--artifact");
if (existsSync(outputPath)) throw new Error("Windows signature receipt output already exists");
const outputParent = lstatSync(dirname(outputPath));
if (outputParent.isSymbolicLink() || !outputParent.isDirectory()) {
  throw new Error("Windows signature receipt output parent must be a regular non-link directory");
}
assertNoSymlinkAncestry(dirname(outputPath), "Windows signature receipt output parent");
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (dirty.trim()) throw new Error("Windows signature receipt requires a clean frozen source checkout");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const version = (JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string }).version;
const artifact = identifyRegularFile(windowsToNodePath(artifactPath), "Windows distribution artifact");
const metadataNodePath = nodeReadablePath(metadataInputPath);
assertNoSymlinkAncestry(windowsToNodePath(artifactPath), "Windows distribution artifact");
assertNoSymlinkAncestry(metadataNodePath, "Azure signing metadata");
const metadata = identifyRegularFile(metadataNodePath, "Azure signing metadata");
const metadataConfig = JSON.parse(readFileSync(metadataNodePath, "utf8")) as Record<string, unknown>;
const profile = JSON.parse(readFileSync(resolve(root, "release", "windows-signing-profile.json"), "utf8")) as WindowsSigningProfile;
const privateSigningIdentity = validateProfile(profile, metadataConfig);

const signingVerifier = nodeToWindowsPath(resolve(root, "scripts", "windows-artifact-sign.ps1"));
const nativeVerify = spawnSync("powershell.exe", [
  "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", signingVerifier,
  "-MetadataPath", nodeToWindowsPath(metadataNodePath), "-VerifyOnly", "-Artifacts", artifactPath,
], { encoding: "utf8", timeout: 5 * 60_000, maxBuffer: 8 * 1024 * 1024 });
if (nativeVerify.status !== 0) throw new Error((nativeVerify.stderr || nativeVerify.stdout || "SignTool verification failed").trim());

const collector = nodeToWindowsPath(resolve(root, "scripts", "collect-release-surface-windows-authenticode.ps1"));
const collected = spawnSync("powershell.exe", [
  "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", collector,
  "-ArtifactPath", artifactPath,
  "-ExpectedPublisherCommonName", profile.publisher.commonName,
  "-ExpectedPublisherOrganization", profile.publisher.organization,
  "-ExpectedPublisherCountry", profile.publisher.country,
  "-ExpectedIssuerOrganization", profile.issuerOrganization,
  "-ExpectedTimestampIssuerOrganization", profile.timestampIssuerOrganization,
], { encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
if (collected.status !== 0) throw new Error((collected.stderr || collected.stdout || "Authenticode collection failed").trim());
const line = collected.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
if (!line) throw new Error("Authenticode collector returned no JSON observation");
const observation = JSON.parse(line) as WindowsAuthenticodeObservation;
if (observation.schema !== "shellx/release-surface-windows-authenticode-observation@1"
  || observation.collector !== "windows-powershell-authenticode-v1" || observation.status !== "Valid"
  || !sameWindowsPath(observation.artifactPath, artifactPath)
  || observation.artifactSha256 !== artifact.sha256
  || observation.artifactBytes !== artifact.bytes
  || JSON.stringify(observation.publisher) !== JSON.stringify(profile.publisher)) {
  throw new Error("Authenticode collector returned invalid profile, artifact, or provenance evidence");
}
const artifactAfter = identifyRegularFile(windowsToNodePath(artifactPath), "Windows distribution artifact after verification");
const metadataAfter = identifyRegularFile(metadataNodePath, "Azure signing metadata after verification");
if (artifactAfter.sha256 !== artifact.sha256 || artifactAfter.bytes !== artifact.bytes
  || metadataAfter.sha256 !== metadata.sha256 || metadataAfter.bytes !== metadata.bytes) {
  throw new Error("artifact or Azure verification-policy metadata changed during native verification");
}
const receipt: ReleaseSurfaceSignatureReceipt = {
  schema: RELEASE_SURFACE_SIGNATURE_RECEIPT_SCHEMA,
  platform: "windows-installed",
  sourceCommit,
  version,
  createdAt: new Date().toISOString(),
  artifact,
  status: "verified",
  nativeVerification: {
    kind: "windows-authenticode",
    collector: observation.collector,
    status: observation.status,
    verifiedAt: observation.verifiedAt,
    publisher: observation.publisher,
    verificationPolicy: {
      provider: "azure-artifact-signing",
      expectedEndpointHost: privateSigningIdentity.endpointHost,
      expectedAccountName: privateSigningIdentity.accountName,
      expectedProfileName: privateSigningIdentity.profileName,
      metadata,
    },
    signerCertificate: observation.signerCertificate,
    timestampCertificate: observation.timestampCertificate,
  },
  checks: [
    { id: "authenticode-valid", status: "pass", observed: "SignTool /pa and Get-AuthenticodeSignature both accepted the exact artifact" },
    { id: "publisher-identity", status: "pass", observed: `Publisher ${profile.publisher.commonName}/${profile.publisher.organization}/${profile.publisher.country} matched the frozen certificate verification policy` },
    { id: "timestamp-valid", status: "pass", observed: "A Microsoft-issued timestamp certificate was present in the valid Authenticode signature" },
  ],
};
const errors = validateReleaseSurfaceSignatureReceipt({
  receipt,
  platform: "windows-installed",
  sourceCommit,
  version,
  artifact,
  expectedStatus: "verified",
  requiredChecks: ["authenticode-valid", "publisher-identity", "timestamp-valid"],
});
if (errors.length > 0) throw new Error(`generated Windows signature receipt is invalid: ${errors.join("; ")}`);
writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
console.log(`Recorded structured Windows signature evidence: ${outputPath}`);

function validateProfile(profile: WindowsSigningProfile, metadata: Record<string, unknown>): {
  endpointHost: string;
  accountName: string;
  profileName: string;
} {
  if (profile.schema !== "shellx/windows-signing-profile@2"
    || !profile.publisher.commonName || !profile.publisher.organization || !/^[A-Z]{2}$/.test(profile.publisher.country)) {
    throw new Error("frozen Windows signing profile is invalid");
  }
  const endpoint = new URL(String(metadata.Endpoint ?? ""));
  const accountName = String(metadata.CodeSigningAccountName ?? "").trim();
  const profileName = String(metadata.CertificateProfileName ?? "").trim();
  if (endpoint.protocol !== "https:" || !endpoint.hostname.endsWith(".codesigning.azure.net")
    || !accountName || !profileName) {
    throw new Error("Azure signing metadata is incomplete or outside the expected endpoint class");
  }
  return { endpointHost: endpoint.hostname, accountName, profileName };
}

function identifyRegularFile(path: string, label: string) {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) throw new Error(`${label} must be a non-empty regular non-link file`);
  const bytes = readFileSync(absolute);
  return { basename: basename(absolute), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

function assertNoSymlinkAncestry(path: string, label: string): void {
  let current = resolve(path);
  while (true) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`${label} must not have a symlink in its ancestry: ${current}`);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function nodeReadablePath(path: string): string {
  return /^[A-Za-z]:\\/.test(path) ? windowsToNodePath(path) : resolve(path);
}

function windowsToNodePath(path: string): string {
  if (process.platform === "win32") return resolve(path);
  const result = spawnSync("wslpath", ["-u", path], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(`unable to map Windows path ${path}`);
  return resolve(result.stdout.trim());
}

function nodeToWindowsPath(path: string): string {
  if (process.platform === "win32") return resolve(path);
  const result = spawnSync("wslpath", ["-w", path], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(`unable to map native verification path ${path}`);
  return result.stdout.trim();
}

function sameWindowsPath(left: string, right: string): boolean {
  const normalize = (value: string) => value.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
  return normalize(left) === normalize(right);
}

function assertCanonicalWindowsPath(path: string, label: string): void {
  if (!/^[A-Za-z]:\\[^/]+/.test(path) || path.includes("/") || path.endsWith("\\") || path.includes("\\\\")
    || path.slice(3).split("\\").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} must be a canonical local absolute Windows path`);
  }
}

function assertWindowsHost(): void {
  const wsl = Boolean(process.env.WSL_INTEROP?.trim() || process.env.WSL_DISTRO_NAME?.trim());
  if (process.platform !== "win32" && !(process.platform === "linux" && wsl)) {
    throw new Error("Windows signature receipt requires native Windows or WSL orchestration");
  }
}

function requiredArg(values: string[], name: string): string {
  const index = values.indexOf(name);
  const value = index >= 0 ? values[index + 1] : values.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}
