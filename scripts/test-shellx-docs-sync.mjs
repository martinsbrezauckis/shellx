#!/usr/bin/env node

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generator = join(repoRoot, "scripts", "generate-shellx-docs.mjs");
const surfaceCoverage = join(repoRoot, "scripts", "test-shellx-docs-surface-coverage.mjs");
const root = mkdtempSync(join(tmpdir(), "shellx-docs-sync-"));
const siteRoot = join(root, "site");
const exportRoot = join(root, "shellx-public-export");

function run(mode, expectSuccess = true) {
  const result = spawnSync(process.execPath, [
    generator,
    mode,
    "--site-root",
    siteRoot,
    "--public-export-root",
    exportRoot,
  ], { cwd: repoRoot, encoding: "utf8" });
  if (expectSuccess && result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${mode} failed with status ${result.status}`);
  }
  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  mkdirSync(siteRoot, { recursive: true });
  mkdirSync(exportRoot, { recursive: true });
  writeFileSync(join(siteRoot, "index.html"), `<!doctype html>
<meta name="robots" content="noindex,nofollow,noarchive" />
<span aria-hidden="true"></span>3 manuals online
<a class="docs-product docs-product--available docs-product--cut" href="manual/cut/">Cut</a>
<a class="docs-product docs-product--available docs-product--canvas" href="manual/canvas/">Canvas</a>
<a class="docs-product docs-product--available docs-product--vault" href="manual/vault/">Vault</a>
<article class="docs-product docs-product--unavailable" aria-label="ShellX Browser manual coming later"><span>Coming later</span></article>
`, "utf8");
  writeFileSync(join(exportRoot, "package.json"), JSON.stringify({ name: "shellx", version: "0.3.5" }), "utf8");

  run("--write-all");
  run("--check-all");

  const surfaceResult = spawnSync(process.execPath, [surfaceCoverage], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert(surfaceResult.status === 0, surfaceResult.stderr || surfaceResult.stdout || "surface coverage failed");

  const siteIndex = readFileSync(join(siteRoot, "index.html"), "utf8");
  const manualHtml = readFileSync(join(siteRoot, "manual/shellx/index.html"), "utf8");
  assert(siteIndex.includes("shellx-docs-card:begin"), "site index is missing the ShellX manual card");
  assert(siteIndex.includes("4 manuals online"), "site index does not derive its manual count from available cards");
  assert(siteIndex.includes('content="noindex,nofollow,noarchive"'), "site index does not preserve tester-only indexing policy");
  assert(manualHtml.includes('content="index,follow"'), "launched ShellX manual must be indexable");
  assert(manualHtml.includes("fonts.googleapis.com") && manualHtml.includes("fonts.gstatic.com"),
    "ShellX manual must load the shared docs typography families");
  assert(manualHtml.includes('<span class="manual-muted" aria-label="Drive manual coming later">Drive</span>')
    && !manualHtml.includes('href="../drive/"'),
    "ShellX manual must not link to the unreleased Drive manual");
  for (const relative of [
    "docs/public/SHELLX_MANUAL.md",
    "docs/public/manual/shellx/content.json",
    "docs/public/manual/shellx/index.html",
    "docs/public/manual/shellx/manual.css",
    "docs/public/manual/shellx/manual.js",
    "docs/public/manual/shellx/visuals.json",
  ]) {
    assert(existsSync(join(exportRoot, relative)), `public export is missing ${relative}`);
  }
  const visuals = JSON.parse(readFileSync(join(repoRoot, "docs/public/manual/shellx/visuals.json"), "utf8"));
  for (const capture of Object.values(visuals.captures)) {
    const relative = join("docs/public/manual/shellx", capture.file);
    assert(existsSync(join(exportRoot, relative)), `public export is missing ${relative}`);
    assert(existsSync(join(siteRoot, "manual/shellx", capture.file)), `docs site is missing ${capture.file}`);
  }

  writeFileSync(join(exportRoot, "package.json"), JSON.stringify({ name: "shellx", version: "0.3.4" }), "utf8");
  const mismatchResult = run("--check-all", false);
  const mismatchRejected = mismatchResult.status !== 0
    && mismatchResult.stderr.includes("does not match manual/source version 0.3.5");
  assert(mismatchRejected, "version-mismatched public export was not rejected");

  writeFileSync(
    join(siteRoot, "index.html"),
    siteIndex.replace("4 manuals online", "99 manuals online"),
    "utf8",
  );
  const countDriftResult = run("--check-site", false);
  assert(countDriftResult.status !== 0, "manual-count drift was not rejected");
  process.stdout.write("ShellX three-target documentation sync checks passed\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
