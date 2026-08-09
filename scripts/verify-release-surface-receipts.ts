import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ReleaseSurfaceInventory } from "./lib/release-surface-inventory";
import { composeFinalSurfaceReceipt } from "./lib/release-surface-receipt-composer";
import { discoverFinalSurfaceReceiptPaths } from "./lib/release-surface-receipt-discovery";
import { verifyReleaseSurfaceEvidenceFiles } from "./lib/release-surface-evidence-files";
import {
  loadFinalSurfaceDriverPlan,
  verifyFinalSurfaceDriverPlan,
} from "./lib/release-surface-driver-plan";
import {
  loadFinalSurfaceContract,
  loadFinalSurfaceReceipt,
  FINAL_SURFACE_RECEIPT_SCHEMA,
  type FinalSurfaceReceipt,
  verifyFinalSurfaceReceipts,
} from "./lib/release-surface-receipts";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const receiptsDir = readArg(args, "--receipts-dir") ?? process.env.SHELLX_RELEASE_SURFACE_RECEIPTS_DIR?.trim();
const sourceCommit = readArg(args, "--source-commit") ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
const version = readArg(args, "--version") ?? packageJson.version;

if (!receiptsDir) {
  console.error("Final surface receipts directory is required.");
  console.error("Set SHELLX_RELEASE_SURFACE_RECEIPTS_DIR or pass --receipts-dir <private-dir>.");
  console.error("This expensive gate is intended only for the frozen signed candidate immediately before publish.");
  process.exit(2);
}

const contract = loadFinalSurfaceContract(join(root, "release", "surface-contract.json"));
const inventory = JSON.parse(readFileSync(join(root, "release", "surface-inventory.json"), "utf8")) as ReleaseSurfaceInventory;
const loadedDriverPlan = loadFinalSurfaceDriverPlan(join(root, "release", "surface-driver-plan.json"));
const driverPlan = verifyFinalSurfaceDriverPlan(
  loadedDriverPlan,
  inventory,
  root,
);
if (driverPlan.status !== "ready") {
  console.error("Final surface driver plan is not release-ready.");
  console.error(`Ready ${driverPlan.counts.ready}/${driverPlan.counts.inventoryCells} platform cells; missing ${driverPlan.counts.missing}.`);
  for (const finding of driverPlan.findings.slice(0, 20)) {
    console.error(`FAIL ${finding.ruleId}${finding.surfaceId ? ` [${finding.surfaceId}]` : ""}: ${finding.detail}`);
  }
  process.exit(1);
}
const resolvedReceiptsDir = resolve(receiptsDir);
const receiptPaths = discoverFinalSurfaceReceiptPaths(resolvedReceiptsDir, contract);
const suppliedReceipts: FinalSurfaceReceipt[] = [];
const recomposeErrors: string[] = [];
for (const path of receiptPaths) {
  let receipt: FinalSurfaceReceipt;
  try {
    receipt = loadFinalSurfaceReceipt(path);
  } catch (error) {
    recomposeErrors.push(`${path}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  if (receipt.schema !== FINAL_SURFACE_RECEIPT_SCHEMA) {
    recomposeErrors.push(`${path}: top-level JSON must use ${FINAL_SURFACE_RECEIPT_SCHEMA}`);
    continue;
  }
  const evidenceById = new Map(receipt.evidenceArtifacts?.map((artifact) => [artifact.id, artifact.relativePath]));
  const runManifest = evidenceById.get("driver-run-manifest");
  const scenarioReport = evidenceById.get("scenario-report");
  const signatureReceipt = evidenceById.get("signature-receipt");
  const candidateAttestation = evidenceById.get("candidate-attestation");
  const candidateTeardown = evidenceById.get("candidate-teardown");
  const installationReceipt = evidenceById.get("installation-receipt");
  if (!runManifest || !scenarioReport || !signatureReceipt || !candidateAttestation
    || !candidateTeardown || !installationReceipt) {
    recomposeErrors.push(`${path}: receipt must declare driver-run-manifest, scenario-report, signature-receipt, candidate-attestation, candidate-teardown, and installation-receipt evidence`);
    continue;
  }
  try {
    const recomposed = composeFinalSurfaceReceipt({
      receiptsDir: resolvedReceiptsDir,
      driverRunDir: dirname(resolve(resolvedReceiptsDir, runManifest)),
      scenarioReportPath: resolve(resolvedReceiptsDir, scenarioReport),
      signatureReceiptPath: resolve(resolvedReceiptsDir, signatureReceipt),
      candidateAttestationPath: resolve(resolvedReceiptsDir, candidateAttestation),
      candidateTeardownPath: resolve(resolvedReceiptsDir, candidateTeardown),
      installationReceiptPath: resolve(resolvedReceiptsDir, installationReceipt),
      contract,
      inventory,
      driverPlan: loadedDriverPlan,
      platform: receipt.platform,
      sourceCommit,
      version,
      rootDir: root,
    });
    if (JSON.stringify(recomposed) !== JSON.stringify(receipt)) {
      recomposeErrors.push(`${path}: supplied receipt does not exactly match independent recomposition from raw evidence`);
      continue;
    }
    suppliedReceipts.push(recomposed);
  } catch (error) {
    recomposeErrors.push(`${path}: raw evidence recomposition failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const evidence = verifyReleaseSurfaceEvidenceFiles(resolvedReceiptsDir, suppliedReceipts);
const result = verifyFinalSurfaceReceipts({
  contract,
  inventory,
  driverPlan: loadedDriverPlan,
  receipts: suppliedReceipts,
  sourceCommit,
  version,
  verifiedEvidenceArtifacts: evidence.verified,
});
const status = result.status === "pass" && evidence.errors.length === 0 && recomposeErrors.length === 0 ? "pass" : "fail";

console.log(`ShellX final frozen-candidate surface gate: ${status.toUpperCase()}`);
console.log(`Inventory ${inventory.digest}: ${result.counts.inventoryItems} surfaces x ${result.counts.requiredPlatforms} installed platforms`);
console.log(`Receipts: ${result.counts.suppliedReceipts}; verified outcomes: ${result.counts.verifiedOutcomes}`);
for (const row of result.findings) {
  const scope = [row.platform, row.surfaceId].filter(Boolean).join(" ");
  console.log(`FAIL ${row.ruleId}${scope ? ` [${scope}]` : ""}: ${row.detail}`);
}
for (const error of evidence.errors) console.log(`FAIL evidence-file: ${error}`);
for (const error of recomposeErrors) console.log(`FAIL receipt-recomposition: ${error}`);
process.exit(status === "pass" ? 0 : 1);

function readArg(values: string[], name: string): string | undefined {
  const index = values.indexOf(name);
  if (index >= 0) return values[index + 1];
  const prefix = `${name}=`;
  return values.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}
