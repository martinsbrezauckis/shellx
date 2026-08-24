#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const FOCUSED_BROWSER_MAX_LINES = 1_000;

// These are debt ratchets, not target sizes. Lower the ceiling whenever an
// extraction lands; never raise one to accommodate new behavior.
const LEGACY_CEILINGS = new Map([
  ["src-tauri/src/host_mcp.rs", { max: 2_000, target: 2_000 }],
  ["src-tauri/src/debug_api.rs", { max: 2_000, target: 2_000 }],
  ["src-tauri/src/shellx_browser.rs", { max: 1_000, target: 1_000 }],
  ["src-tauri/src/shellx_browser_model.rs", { max: 858, target: 858 }],
  ["src-tauri/src/shellx_browser_scripts.rs", { max: 1_033, target: 1_000 }],
  ["src/components/ShellxBrowserApp.tsx", { max: 1_000, target: 1_000 }],
  ["src/App.css", { max: 2_000, target: 2_000 }],
  ["src/styles/app-core.css", { max: 2_000, target: 2_000 }],
  ["src/styles/app-workspace.css", { max: 2_000, target: 2_000 }],
  ["src/styles/app-settings.css", { max: 2_000, target: 2_000 }],
  ["src/styles/app-tools.css", { max: 2_000, target: 2_000 }],
  ["src/styles/app-navigation.css", { max: 2_000, target: 2_000 }],
  ["src/styles/app-polish.css", { max: 2_000, target: 2_000 }],
]);

function filesUnder(root) {
  const files = [];
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) return files;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function lineCount(path) {
  const source = readFileSync(path, "utf8");
  if (!source) return 0;
  const lines = source.split(/\r?\n/).length;
  return source.endsWith("\n") ? lines - 1 : lines;
}

function repositoryRelative(path) {
  return relative(repositoryRoot, path).replaceAll("\\", "/");
}

function isFocusedBrowserModule(path) {
  if (path.startsWith("src/browser/") && [".ts", ".tsx", ".css"].includes(extname(path))) {
    return true;
  }
  if (path.startsWith("src-tauri/src/host_mcp/") && path.endsWith(".rs")) return true;
  return /^src-tauri\/src\/(debug_api_browser|shellx_browser_).+\.rs$/.test(path);
}

const repositoryRoot = resolve(import.meta.dirname, "../..");
const candidates = [
  ...LEGACY_CEILINGS.keys(),
  ...filesUnder(resolve(repositoryRoot, "src/browser")).map(repositoryRelative),
  ...filesUnder(resolve(repositoryRoot, "src-tauri/src/host_mcp")).map((path) =>
    repositoryRelative(path),
  ),
  ...filesUnder(resolve(repositoryRoot, "src-tauri/src"))
    .map(repositoryRelative)
    .filter((path) => isFocusedBrowserModule(path)),
];

const rows = [...new Set(candidates)]
  .sort()
  .map((path) => {
    const debt = LEGACY_CEILINGS.get(path);
    return {
      path,
      lines: lineCount(resolve(repositoryRoot, path)),
      max: debt?.max ?? FOCUSED_BROWSER_MAX_LINES,
      target: debt?.target ?? FOCUSED_BROWSER_MAX_LINES,
      legacy: Boolean(debt),
    };
  });

const violations = rows.filter((row) => row.lines > row.max);
const debt = rows.filter((row) => row.legacy && row.lines > row.target);

console.log("Source size budget");
console.log(
  `PASS ${rows.length - violations.length}/${rows.length} tracked files; focused Browser limit ${FOCUSED_BROWSER_MAX_LINES} lines`,
);
for (const row of violations) {
  console.error(`FAIL ${row.path}: ${row.lines} lines exceeds ceiling ${row.max}`);
}
if (debt.length > 0) {
  console.log(`DEBT ${debt.length} legacy file(s) remain above extraction targets; ceilings cannot increase.`);
}
if (violations.length > 0) process.exitCode = 1;
