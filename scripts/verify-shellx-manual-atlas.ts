import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateManualAtlasReview,
  type ManualAtlasVisuals,
} from "./lib/manual-atlas-review";
import { calculateManualAtlasProductSourceSha256 } from "./lib/manual-atlas-product-source.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manualRoot = join(repoRoot, "docs", "public", "manual", "shellx");
const visualsPath = join(manualRoot, "visuals.json");
const visuals = JSON.parse(readFileSync(visualsPath, "utf8")) as ManualAtlasVisuals;
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version?: string };
if (typeof packageJson.version !== "string") throw new Error("package.json version is missing");
const productSourceSha256 = calculateManualAtlasProductSourceSha256(repoRoot);
const imageSha256 = new Map<string, string>();

for (const capture of Object.values(visuals.captures ?? {})) {
  const path = join(manualRoot, capture.file);
  if (!existsSync(path)) continue;
  imageSha256.set(capture.file, createHash("sha256").update(readFileSync(path)).digest("hex"));
}

const errors = validateManualAtlasReview({
  visuals,
  imageSha256,
  expectedProductSourceSha256: productSourceSha256,
  expectedAppVersion: packageJson.version,
});
if (errors.length > 0) {
  console.error(`ShellX manual atlas is not release-ready (${errors.length} issue(s)):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`ShellX manual atlas review passed: ${imageSha256.size} installed-Tauri captures are byte-bound and documented`);
