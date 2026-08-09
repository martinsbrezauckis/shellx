import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { releaseSurfaceScenarioEvidencePath } from "./lib/release-surface-receipt-composer";
import { discoverFinalSurfaceReceiptPaths } from "./lib/release-surface-receipt-discovery";
import { loadFinalSurfaceContract } from "./lib/release-surface-receipts";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-final-receipt-discovery-"));

try {
  const contract = loadFinalSurfaceContract(join(root, "release", "surface-contract.json"));
  const linuxReceipt = join(temp, "linux-installed-receipt.json");
  const macosReceipt = join(temp, "macos-installed-receipt.json");
  for (const path of [
    join(temp, "health.json"),
    join(temp, "grok--local.json"),
    join(temp, "scenario.json"),
    linuxReceipt,
    macosReceipt,
  ]) {
    writeFileSync(path, "{}\n", "utf8");
  }
  assert.deepEqual(
    discoverFinalSurfaceReceiptPaths(temp, contract),
    [linuxReceipt, macosReceipt],
    "discovery must select only exact contract platform receipt filenames and ignore raw root JSON evidence",
  );
  assert.equal(
    releaseSurfaceScenarioEvidencePath(
      join(temp, "linux-installed", "scenario.json"),
      "grok--local.json",
    ),
    join(temp, "linux-installed", "grok--local.json"),
    "scenario-bound raw evidence must resolve within its platform evidence directory",
  );
  console.log("Release surface final receipt discovery tests passed");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
