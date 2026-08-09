import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkBundleBudget } from "./check-bundle-budget.mjs";

const distDir = mkdtempSync(join(tmpdir(), "shellx-bundle-budget-"));
mkdirSync(join(distDir, ".vite"), { recursive: true });
mkdirSync(join(distDir, "assets"), { recursive: true });

const manifest = {
  "index.html": {
    file: "assets/main.js",
    isEntry: true,
    imports: ["shared.js"],
    dynamicImports: ["lazy.js"],
    css: ["assets/main.css"],
  },
  "shared.js": { file: "assets/shared.js" },
  "lazy.js": { file: "assets/lazy.js" },
};
writeFileSync(join(distDir, ".vite", "manifest.json"), JSON.stringify(manifest));
writeFileSync(join(distDir, "assets", "main.js"), "m".repeat(100));
writeFileSync(join(distDir, "assets", "shared.js"), "s".repeat(50));
writeFileSync(join(distDir, "assets", "lazy.js"), "l".repeat(10_000));
writeFileSync(join(distDir, "assets", "main.css"), "c".repeat(25));

const passing = checkBundleBudget({
  distDir,
  budgets: {
    "index.html": {
      label: "fixture",
      jsBytes: 150,
      jsGzipBytes: 100,
      cssBytes: 25,
      cssGzipBytes: 100,
    },
  },
});
assert.equal(passing.status, "pass");
assert.equal(passing.entries[0].js.bytes, 150, "static entry and imports count once");
assert.deepEqual(
  passing.entries[0].js.files,
  ["assets/main.js", "assets/shared.js"],
  "dynamic imports stay outside the initial-load budget",
);

const failing = checkBundleBudget({
  distDir,
  budgets: {
    "index.html": {
      label: "fixture",
      jsBytes: 149,
      jsGzipBytes: 100,
      cssBytes: 24,
      cssGzipBytes: 100,
    },
  },
});
assert.equal(failing.status, "fail");
assert.match(failing.entries[0].violations.join("; "), /JS 150 > 149/);
assert.match(failing.entries[0].violations.join("; "), /CSS 25 > 24/);

writeFileSync(join(distDir, ".vite", "manifest.json"), "{not-json");
assert.throws(
  () => checkBundleBudget({ distDir, budgets: {} }),
  /Vite manifest is not valid JSON/,
  "malformed manifests fail with a bounded validation error",
);

rmSync(distDir, { recursive: true, force: true });
console.log("PASS bundle budget tests");
