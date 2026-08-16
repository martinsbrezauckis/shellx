import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { composeFinalSurfaceReceipt } from "./release-surface-receipt-composer";
import { recoverInterruptedReleaseSurfaceSlice } from "./release-surface-interrupted-recovery";
import { composeValidatedReleaseSurfaceReceiptUnion } from "./release-surface-receipt-union";
import type { FinalSurfaceDriverPlan } from "./release-surface-driver-plan";
import type { FinalSurfaceContract, FinalSurfaceReceipt } from "./release-surface-receipts";
import type { ReleasePlatform, ReleaseSurfaceInventory } from "./release-surface-inventory";

export const RELEASE_SURFACE_UNION_MANIFEST_SCHEMA = "shellx/release-surface-union-manifest@1";

interface ReleaseSurfaceUnionManifestBaseSource {
  sourceId: string;
  sourceKind: "interrupted-discovery" | "complete-discovery" | "targeted-closure";
}

interface ReleaseSurfaceUnionManifestInterruptedSource extends ReleaseSurfaceUnionManifestBaseSource {
  sourceKind: "interrupted-discovery";
  driverRunDir: string;
  orchestration: string;
  lifecycle: string;
  profileCleanup: string;
  candidateAttestation: string;
  signatureReceipt: string;
  installationReceipt: string;
}

interface ReleaseSurfaceUnionManifestSealedSource extends ReleaseSurfaceUnionManifestBaseSource {
  sourceKind: "complete-discovery" | "targeted-closure";
  driverRunDir: string;
  scenarioReport?: string;
  signatureReceipt: string;
  candidateAttestation: string;
  candidateTeardown: string;
  installationReceipt: string;
}

export interface ReleaseSurfaceUnionManifest {
  schema: typeof RELEASE_SURFACE_UNION_MANIFEST_SCHEMA;
  platform: ReleasePlatform;
  sourceCommit: string;
  version: string;
  inventoryDigest: string;
  scenarioSourceId: string;
  sources: Array<ReleaseSurfaceUnionManifestInterruptedSource | ReleaseSurfaceUnionManifestSealedSource>;
}

export function composeFinalSurfaceReceiptFromUnionManifest(input: {
  receiptsDir: string;
  manifestPath: string;
  contract: FinalSurfaceContract;
  inventory: ReleaseSurfaceInventory;
  driverPlan: FinalSurfaceDriverPlan;
  platform: ReleasePlatform;
  sourceCommit: string;
  version: string;
  rootDir: string;
}): FinalSurfaceReceipt {
  const receiptsDir = resolve(input.receiptsDir);
  const manifestPath = containedFile(receiptsDir, input.manifestPath, "release surface union manifest");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ReleaseSurfaceUnionManifest;
  validateManifest(manifest, input);
  const slices: Parameters<typeof composeValidatedReleaseSurfaceReceiptUnion>[0]["slices"] = [];
  for (const source of manifest.sources) {
    if (source.sourceKind === "interrupted-discovery") {
      slices.push({
        kind: "recovered",
        recovery: recoverInterruptedReleaseSurfaceSlice({
          sourceId: source.sourceId,
          receiptsDir,
          driverRunDir: sourcePath(receiptsDir, source.driverRunDir, "interrupted driver run directory"),
          orchestrationPath: sourcePath(receiptsDir, source.orchestration, "interrupted orchestration"),
          lifecyclePath: sourcePath(receiptsDir, source.lifecycle, "interrupted lifecycle"),
          profileCleanupPath: sourcePath(receiptsDir, source.profileCleanup, "interrupted profile cleanup"),
          candidateAttestationPath: sourcePath(receiptsDir, source.candidateAttestation, "interrupted candidate attestation"),
          signatureReceiptPath: sourcePath(receiptsDir, source.signatureReceipt, "interrupted signature receipt"),
          installationReceiptPath: sourcePath(receiptsDir, source.installationReceipt, "interrupted installation receipt"),
          contract: input.contract,
          inventory: input.inventory,
          driverPlan: input.driverPlan,
          platform: input.platform,
          sourceCommit: input.sourceCommit,
          version: input.version,
          rootDir: input.rootDir,
        }),
      });
      continue;
    }
    const receipt = composeFinalSurfaceReceipt({
      receiptsDir,
      driverRunDir: sourcePath(receiptsDir, source.driverRunDir, "sealed driver run directory"),
      scenarioReportPath: source.scenarioReport
        ? sourcePath(receiptsDir, source.scenarioReport, "sealed scenario report")
        : undefined,
      signatureReceiptPath: sourcePath(receiptsDir, source.signatureReceipt, "sealed signature receipt"),
      candidateAttestationPath: sourcePath(receiptsDir, source.candidateAttestation, "sealed candidate attestation"),
      candidateTeardownPath: sourcePath(receiptsDir, source.candidateTeardown, "sealed candidate teardown"),
      installationReceiptPath: sourcePath(receiptsDir, source.installationReceipt, "sealed installation receipt"),
      contract: input.contract,
      inventory: input.inventory,
      driverPlan: input.driverPlan,
      platform: input.platform,
      sourceCommit: input.sourceCommit,
      version: input.version,
      rootDir: input.rootDir,
      coverage: source.sourceKind === "targeted-closure" ? "slice" : "complete",
    });
    slices.push({ kind: "receipt", value: { sourceId: source.sourceId, sourceKind: source.sourceKind, receipt } });
  }
  const receipt = composeValidatedReleaseSurfaceReceiptUnion({
    inventory: input.inventory,
    driverPlan: input.driverPlan,
    platform: input.platform,
    sourceCommit: input.sourceCommit,
    version: input.version,
    slices,
    scenarioSourceId: manifest.scenarioSourceId,
  });
  const bytes = readFileSync(manifestPath);
  const relativePath = relative(receiptsDir, manifestPath).split(sep).join("/");
  receipt.evidenceArtifacts.unshift({
    id: "matrix-outcome-union",
    relativePath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  });
  return receipt;
}

function validateManifest(
  manifest: ReleaseSurfaceUnionManifest,
  input: Pick<Parameters<typeof composeFinalSurfaceReceiptFromUnionManifest>[0], "platform" | "sourceCommit" | "version" | "inventory">,
): void {
  requireOnlyKeys(
    manifest,
    ["schema", "platform", "sourceCommit", "version", "inventoryDigest", "scenarioSourceId", "sources"],
    "release surface union manifest",
  );
  if (manifest.schema !== RELEASE_SURFACE_UNION_MANIFEST_SCHEMA
    || manifest.platform !== input.platform
    || manifest.sourceCommit !== input.sourceCommit
    || manifest.version !== input.version
    || manifest.inventoryDigest !== input.inventory.digest) {
    throw new Error("release surface union manifest identity drifted from the frozen candidate");
  }
  if (!Array.isArray(manifest.sources) || manifest.sources.length < 2 || manifest.sources.length > 512) {
    throw new Error("release surface union manifest requires two to 512 bounded sources");
  }
  const ids = new Set<string>();
  let scenarioSourceFound = false;
  for (const source of manifest.sources) {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(source.sourceId) || ids.has(source.sourceId)) {
      throw new Error(`release surface union source id is invalid or duplicated: ${JSON.stringify(source.sourceId)}`);
    }
    ids.add(source.sourceId);
    if (source.sourceId === manifest.scenarioSourceId
      && source.sourceKind !== "interrupted-discovery"
      && Boolean(source.scenarioReport)) {
      scenarioSourceFound = true;
    }
    if (source.sourceKind === "interrupted-discovery") {
      requireOnlyKeys(source, [
        "sourceId", "sourceKind", "driverRunDir", "orchestration", "lifecycle", "profileCleanup",
        "candidateAttestation", "signatureReceipt", "installationReceipt",
      ], `release surface union source ${source.sourceId}`);
      for (const value of [
        source.driverRunDir, source.orchestration, source.lifecycle, source.profileCleanup,
        source.candidateAttestation, source.signatureReceipt, source.installationReceipt,
      ]) requireRelativePath(value, source.sourceId);
    } else if (source.sourceKind === "complete-discovery" || source.sourceKind === "targeted-closure") {
      requireOnlyKeys(source, [
        "sourceId", "sourceKind", "driverRunDir", "scenarioReport", "signatureReceipt",
        "candidateAttestation", "candidateTeardown", "installationReceipt",
      ], `release surface union source ${source.sourceId}`);
      if (source.sourceKind === "complete-discovery" && !source.scenarioReport) {
        throw new Error(`release surface union complete source ${source.sourceId} requires a scenario report`);
      }
      for (const value of [
        source.driverRunDir, ...(source.scenarioReport ? [source.scenarioReport] : []), source.signatureReceipt, source.candidateAttestation,
        source.candidateTeardown, source.installationReceipt,
      ]) requireRelativePath(value, source.sourceId);
    } else {
      throw new Error(`release surface union source ${source.sourceId} has invalid kind`);
    }
  }
  if (!scenarioSourceFound) throw new Error("release surface union scenario source must name one sealed source");
}

function sourcePath(root: string, value: string, label: string): string {
  requireRelativePath(value, label);
  const absolute = resolve(root, value);
  const rel = relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) {
    throw new Error(`${label} escapes the private receipts directory`);
  }
  return absolute;
}

function containedFile(root: string, path: string, label: string): string {
  const absolute = resolve(path);
  const rel = relative(root, absolute);
  if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) {
    throw new Error(`${label} must be inside the private receipts directory`);
  }
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
  return absolute;
}

function requireRelativePath(value: string, label: string): void {
  if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("/")
    || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`release surface union ${label} path is not a canonical relative path`);
  }
}

function requireOnlyKeys(value: unknown, allowed: readonly string[], label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown) throw new Error(`${label} contains undeclared field ${unknown}`);
}
