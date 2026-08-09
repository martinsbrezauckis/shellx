#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

export const BUNDLE_BUDGETS = {
  "index.html": {
    label: "ShellX main window",
    jsBytes: 900_000,
    jsGzipBytes: 280_000,
    cssBytes: 260_000,
    cssGzipBytes: 50_000,
  },
  "shellx-browser.html": {
    label: "ShellX Browser window",
    jsBytes: 350_000,
    jsGzipBytes: 110_000,
    cssBytes: 260_000,
    cssGzipBytes: 50_000,
  },
};

function collectStaticFiles(manifest, entryKey) {
  const entry = manifest[entryKey];
  if (!entry?.isEntry) throw new Error(`Vite manifest is missing entry ${entryKey}`);
  const js = new Set();
  const css = new Set();
  const visited = new Set();

  function visit(key) {
    if (visited.has(key)) return;
    visited.add(key);
    const chunk = manifest[key];
    if (!chunk) throw new Error(`Vite manifest import ${key} is missing`);
    if (typeof chunk.file === "string" && chunk.file.endsWith(".js")) js.add(chunk.file);
    for (const file of chunk.css ?? []) css.add(file);
    for (const dependency of chunk.imports ?? []) visit(dependency);
  }

  visit(entryKey);
  return { js: [...js].sort(), css: [...css].sort() };
}

function readManifest(manifestPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Vite manifest is not valid JSON: ${detail}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Vite manifest must be an object");
  }
  return parsed;
}

function measureFiles(distDir, files) {
  let bytes = 0;
  let gzipBytes = 0;
  for (const relativePath of files) {
    const path = resolve(distDir, relativePath);
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`Bundle budget asset is missing: ${relativePath}`);
    }
    const content = readFileSync(path);
    bytes += content.length;
    gzipBytes += gzipSync(content, { level: 9 }).length;
  }
  return { bytes, gzipBytes };
}

export function checkBundleBudget({ distDir = "dist", budgets = BUNDLE_BUDGETS } = {}) {
  const manifestPath = resolve(distDir, ".vite", "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`Vite manifest not found: ${manifestPath}`);
  const manifest = readManifest(manifestPath);
  const entries = [];

  for (const [entryKey, budget] of Object.entries(budgets)) {
    const files = collectStaticFiles(manifest, entryKey);
    const js = measureFiles(distDir, files.js);
    const css = measureFiles(distDir, files.css);
    const violations = [];
    if (js.bytes > budget.jsBytes) violations.push(`JS ${js.bytes} > ${budget.jsBytes}`);
    if (js.gzipBytes > budget.jsGzipBytes) violations.push(`gzip JS ${js.gzipBytes} > ${budget.jsGzipBytes}`);
    if (css.bytes > budget.cssBytes) violations.push(`CSS ${css.bytes} > ${budget.cssBytes}`);
    if (css.gzipBytes > budget.cssGzipBytes) violations.push(`gzip CSS ${css.gzipBytes} > ${budget.cssGzipBytes}`);
    entries.push({
      entry: entryKey,
      label: budget.label,
      status: violations.length === 0 ? "pass" : "fail",
      js: { ...js, files: files.js },
      css: { ...css, files: files.css },
      budget,
      violations,
    });
  }

  return {
    schemaVersion: "shellx.bundle-budget.v1",
    generatedAt: new Date().toISOString(),
    status: entries.every((entry) => entry.status === "pass") ? "pass" : "fail",
    entries,
  };
}

function formatBytes(bytes) {
  return `${(bytes / 1_000).toFixed(1)} kB`;
}

function main() {
  const receipt = checkBundleBudget();
  const receiptSetting = process.env.SHELLX_BUNDLE_BUDGET_RECEIPT?.trim();
  const receiptPath = receiptSetting ? resolve(receiptSetting) : null;
  rmSync(resolve("dist", ".vite"), { recursive: true, force: true });
  if (receiptPath) {
    mkdirSync(dirname(receiptPath), { recursive: true });
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), "utf8");
  }
  console.log("\nBundle budget");
  for (const entry of receipt.entries) {
    console.log(
      `${entry.status.toUpperCase()} ${entry.label}: ` +
      `JS ${formatBytes(entry.js.bytes)} (${formatBytes(entry.js.gzipBytes)} gzip), ` +
      `CSS ${formatBytes(entry.css.bytes)} (${formatBytes(entry.css.gzipBytes)} gzip)`,
    );
    for (const violation of entry.violations) console.error(`  ${violation}`);
  }
  if (receiptPath) console.log(`receipt=${receiptPath}`);
  if (receipt.status !== "pass") process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
