import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ReleasePlatform, ReleaseSurfaceInventory } from "./lib/release-surface-inventory";
import { composeFinalSurfaceReceipt } from "./lib/release-surface-receipt-composer";
import { loadFinalSurfaceDriverPlan } from "./lib/release-surface-driver-plan";
import { loadFinalSurfaceContract } from "./lib/release-surface-receipts";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const receiptsDir = requiredArg(args, "--receipts-dir");
const driverRunDir = requiredArg(args, "--driver-run-dir");
const scenarioReportPath = requiredArg(args, "--scenario-report");
const signatureReceiptPath = requiredArg(args, "--signature-receipt");
const candidateAttestationPath = requiredArg(args, "--candidate-attestation");
const candidateTeardownPath = requiredArg(args, "--candidate-teardown");
const installationReceiptPath = requiredArg(args, "--installation-receipt");
const outputPath = requiredArg(args, "--out");
const platform = requiredArg(args, "--platform") as ReleasePlatform;
if (!(["windows-installed", "macos-installed", "linux-installed"] as string[]).includes(platform)) {
  throw new Error("valid --platform is required");
}
if (resolve(dirname(outputPath)) !== resolve(receiptsDir)) {
  throw new Error("final receipt output must be a top-level file in --receipts-dir");
}
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (dirty.trim()) throw new Error("final receipt composition requires a clean frozen source checkout");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
const inventory = JSON.parse(readFileSync(join(root, "release", "surface-inventory.json"), "utf8")) as ReleaseSurfaceInventory;
const receipt = composeFinalSurfaceReceipt({
  receiptsDir,
  driverRunDir,
  scenarioReportPath,
  signatureReceiptPath,
  candidateAttestationPath,
  candidateTeardownPath,
  installationReceiptPath,
  contract: loadFinalSurfaceContract(join(root, "release", "surface-contract.json")),
  inventory,
  driverPlan: loadFinalSurfaceDriverPlan(join(root, "release", "surface-driver-plan.json")),
  platform,
  sourceCommit,
  version,
  rootDir: root,
});
writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
console.log(`Composed ${platform} final receipt with ${receipt.outcomes.length} exact surface outcomes: ${outputPath}`);

function requiredArg(values: string[], name: string): string {
  const index = values.indexOf(name);
  const value = index >= 0 ? values[index + 1] : values.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}
