import { readFileSync } from "node:fs";

let failures = 0;

function assert(condition: boolean, label: string): void {
  console.log(`  ${condition ? "✓" : "✗"} ${label}`);
  if (!condition) failures += 1;
}

function source(path: string): string {
  return readFileSync(path, "utf8");
}

function lineCount(value: string): number {
  const lines = value.split(/\r?\n/).length;
  return value.endsWith("\n") ? lines - 1 : lines;
}

console.log("\n=== shellx browser model modules ===");

const facade = source("src-tauri/src/shellx_browser_model.rs");
const lib = source("src-tauri/src/lib.rs");
const modules = [
  ["artifact", "src-tauri/src/shellx_browser_artifact_model.rs", 650],
  ["engine", "src-tauri/src/shellx_browser_engine_model.rs", 400],
  ["observation", "src-tauri/src/shellx_browser_observation_model.rs", 650],
  ["settings", "src-tauri/src/shellx_browser_settings_model.rs", 650],
] as const;

assert(lineCount(facade) <= 858, "Browser model facade cannot regrow past its extracted size");
assert(!facade.includes("include!("), "Browser model split uses real Rust modules, not textual includes");

for (const [name, path, maxLines] of modules) {
  const moduleSource = source(path);
  assert(lineCount(moduleSource) <= maxLines, `${name} model stays within its focused size ceiling`);
  assert(lib.includes(`mod shellx_browser_${name}_model;`), `${name} model is registered in the crate`);
  assert(
    facade.includes(`pub use crate::shellx_browser_${name}_model::*;`),
    `${name} model remains available through the stable Browser facade`,
  );
}

const modelFamily = [facade, ...modules.map(([, path]) => source(path))].join("\n");
for (const typeName of [
  "BrowserAutonomyMode",
  "BrowserEngineWaitlistEntry",
  "BrowserTraceExportRequest",
  "BrowserLocatorSuggestion",
  "BrowserDownloadRequest",
]) {
  const definitions = modelFamily.match(new RegExp(`pub (?:struct|enum) ${typeName}\\b`, "g")) ?? [];
  assert(definitions.length === 1, `${typeName} has exactly one model definition`);
}

assert(
  facade.includes("deserialize_option_bool_lossy") &&
    facade.includes("deserialize_option_string_lossy") &&
    facade.includes("deserialize_string_lossy"),
  "lossy deserializers retain their crate-level facade contract",
);

if (failures > 0) {
  console.error(`\n${failures} Browser model module assertion(s) failed.`);
  process.exit(1);
}

console.log("\nAll ShellX Browser model module assertions passed.");
