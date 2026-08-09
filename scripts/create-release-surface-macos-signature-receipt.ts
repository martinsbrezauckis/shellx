import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  assertCanonicalMacosAbsolutePath,
  assertReleaseSurfaceNoSymlinkAncestry,
  collectReleaseSurfaceMacosSignatureVerification,
  identifyReleaseSurfaceRegularFile,
} from "./lib/release-surface-macos-native";
import {
  RELEASE_SURFACE_SIGNATURE_RECEIPT_SCHEMA,
  validateReleaseSurfaceSignatureReceipt,
  type ReleaseSurfaceSignatureReceipt,
} from "./lib/release-surface-signature-receipt";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
if (process.platform !== "darwin") throw new Error("macOS signature receipt creation requires a native macOS host");
const artifactInput = requiredArg(args, "--artifact");
assertCanonicalMacosAbsolutePath(artifactInput, "--artifact");
const artifactPath = resolve(artifactInput);
const outputPath = resolve(requiredArg(args, "--out"));
if (existsSync(outputPath)) throw new Error("macOS signature receipt output already exists");
const outputParent = lstatSync(dirname(outputPath));
if (outputParent.isSymbolicLink() || !outputParent.isDirectory()) {
  throw new Error("macOS signature receipt output parent must be a regular non-link directory");
}
assertReleaseSurfaceNoSymlinkAncestry(artifactPath, "macOS distribution artifact");
assertReleaseSurfaceNoSymlinkAncestry(dirname(outputPath), "macOS signature receipt output parent");
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (dirty.trim()) throw new Error("macOS signature receipt requires a clean frozen source checkout");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const version = (JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string }).version;
const artifact = identifyReleaseSurfaceRegularFile(artifactPath, "macOS distribution DMG");
const nativeVerification = collectReleaseSurfaceMacosSignatureVerification({ artifactPath, artifact });
const artifactAfter = identifyReleaseSurfaceRegularFile(artifactPath, "macOS distribution DMG after verification");
if (artifactAfter.sha256 !== artifact.sha256 || artifactAfter.bytes !== artifact.bytes) {
  throw new Error("macOS distribution DMG changed during native verification");
}
const receipt: ReleaseSurfaceSignatureReceipt = {
  schema: RELEASE_SURFACE_SIGNATURE_RECEIPT_SCHEMA,
  platform: "macos-installed",
  sourceCommit,
  version,
  createdAt: new Date().toISOString(),
  artifact,
  status: "verified",
  nativeVerification,
  checks: [
    {
      id: "codesign-deep-strict",
      status: "pass",
      observed: "codesign accepted the mounted top-level shellX.app with deep, strict, and all-architecture verification",
    },
    {
      id: "gatekeeper-assess",
      status: "pass",
      observed: "Gatekeeper accepted the mounted top-level shellX.app as Notarized Developer ID software",
    },
    {
      id: "notary-staple",
      status: "pass",
      observed: "stapler validated tickets on both the mounted shellX.app and the exact DMG bytes",
    },
  ],
};
const errors = validateReleaseSurfaceSignatureReceipt({
  receipt,
  platform: "macos-installed",
  sourceCommit,
  version,
  artifact,
  expectedStatus: "verified",
  requiredChecks: ["codesign-deep-strict", "gatekeeper-assess", "notary-staple"],
});
if (errors.length > 0) throw new Error(`generated macOS signature receipt is invalid: ${errors.join("; ")}`);
writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
console.log(`Recorded structured macOS signature evidence: ${outputPath}`);

function requiredArg(values: string[], name: string): string {
  const index = values.indexOf(name);
  const value = index >= 0 ? values[index + 1] : values.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}
