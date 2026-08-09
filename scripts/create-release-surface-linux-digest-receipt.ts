import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import {
  RELEASE_SURFACE_SIGNATURE_RECEIPT_SCHEMA,
  validateReleaseSurfaceSignatureReceipt,
  type ReleaseSurfaceSignatureReceipt,
} from "./lib/release-surface-signature-receipt";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
if (process.platform !== "linux") throw new Error("Linux digest receipt creation requires a Linux host");
const artifactPath = resolve(requiredArg(args, "--artifact"));
const outputPath = resolve(requiredArg(args, "--out"));
assertNoSymlinkAncestry(artifactPath, "Linux artifact");
if (existsSync(outputPath)) throw new Error("Linux digest receipt output already exists");
const outputParent = lstatSync(dirname(outputPath));
if (outputParent.isSymbolicLink() || !outputParent.isDirectory()) {
  throw new Error("Linux digest receipt parent must be a regular non-link directory");
}
assertNoSymlinkAncestry(dirname(outputPath), "Linux digest receipt parent");
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (dirty.trim()) throw new Error("Linux digest receipt requires a clean frozen source checkout");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const version = (JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string }).version;
const artifact = identifyRegularFile(artifactPath);
const contract = JSON.parse(readFileSync(resolve(root, "release", "surface-contract.json"), "utf8")) as {
  platforms: Record<string, { signatureStatus: "verified" | "digest-verified"; requiredSignatureChecks: string[] }>;
};
const linuxContract = contract.platforms["linux-installed"];
if (!linuxContract || linuxContract.signatureStatus !== "digest-verified") {
  throw new Error("final surface contract does not declare Linux digest verification");
}
const receipt: ReleaseSurfaceSignatureReceipt = {
  schema: RELEASE_SURFACE_SIGNATURE_RECEIPT_SCHEMA,
  platform: "linux-installed",
  sourceCommit,
  version,
  createdAt: new Date().toISOString(),
  artifact,
  status: "digest-verified",
  nativeVerification: { kind: "artifact-digest", algorithm: "sha256", sha256: artifact.sha256 },
  checks: linuxContract.requiredSignatureChecks.map((id) => ({
    id,
    status: "pass",
    observed: `Recomputed SHA-256 ${artifact.sha256} from the exact Linux artifact bytes.`,
  })),
};
const errors = validateReleaseSurfaceSignatureReceipt({
  receipt,
  platform: "linux-installed",
  sourceCommit,
  version,
  artifact,
  expectedStatus: linuxContract.signatureStatus,
  requiredChecks: linuxContract.requiredSignatureChecks,
});
if (errors.length > 0) throw new Error(`generated Linux digest receipt is invalid: ${errors.join("; ")}`);
const artifactAfter = identifyRegularFile(artifactPath);
if (JSON.stringify(artifactAfter) !== JSON.stringify(artifact)) throw new Error("Linux artifact changed before digest receipt creation");
writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
console.log(`Recorded exact Linux artifact digest: ${outputPath}`);

function identifyRegularFile(path: string) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) throw new Error("Linux artifact must be a non-empty regular non-link file");
  const bytes = readFileSync(path);
  return { basename: basename(path), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

function assertNoSymlinkAncestry(path: string, label: string): void {
  let current = resolve(path);
  while (true) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`${label} must not have a symlink in its ancestry`);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function requiredArg(values: string[], name: string): string {
  const index = values.indexOf(name);
  const value = index >= 0 ? values[index + 1] : values.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}
