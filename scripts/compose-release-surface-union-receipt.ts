import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { composeFinalSurfaceReceiptFromUnionManifest } from "./lib/release-surface-union-manifest";
import { loadFinalSurfaceDriverPlan } from "./lib/release-surface-driver-plan";
import { loadFinalSurfaceContract } from "./lib/release-surface-receipts";
import type { ReleasePlatform, ReleaseSurfaceInventory } from "./lib/release-surface-inventory";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const receiptsDir = requiredArg(args, "--receipts-dir");
const manifestPath = requiredArg(args, "--union-manifest");
const outputPath = requiredArg(args, "--out");
const platform = requiredArg(args, "--platform") as ReleasePlatform;
if (!("windows-installed macos-installed linux-installed".split(" ") as string[]).includes(platform)) {
  throw new Error("valid --platform is required");
}
if (resolve(dirname(outputPath)) !== resolve(receiptsDir)) {
  throw new Error("final union receipt output must be a top-level file in --receipts-dir");
}
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (dirty.trim()) throw new Error("final union receipt composition requires a clean controller checkout");
const sourceCommit = requiredArg(args, "--source-commit");
const version = requiredArg(args, "--version");
const inventory = JSON.parse(readFileSync(join(root, "release", "surface-inventory.json"), "utf8")) as ReleaseSurfaceInventory;
const receipt = composeFinalSurfaceReceiptFromUnionManifest({
  receiptsDir,
  manifestPath,
  contract: loadFinalSurfaceContract(join(root, "release", "surface-contract.json")),
  inventory,
  driverPlan: loadFinalSurfaceDriverPlan(join(root, "release", "surface-driver-plan.json")),
  platform,
  sourceCommit,
  version,
  rootDir: root,
});
writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
console.log(`Composed ${platform} union receipt with ${receipt.outcomes.length} exact surface outcomes: ${outputPath}`);

function requiredArg(values: string[], name: string): string {
  const index = values.indexOf(name);
  const value = index >= 0 ? values[index + 1] : values.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}
