import { readFileSync } from "node:fs";

let failures = 0;

function assert(condition: boolean, label: string): void {
  console.log(`  ${condition ? "✓" : "✗"} ${label}`);
  if (!condition) failures += 1;
}

console.log("\n=== shellx browser policy ===");

const policySource = readFileSync("src-tauri/src/shellx_browser_policy.rs", "utf8");
const taskSource = [
  readFileSync("src-tauri/src/shellx_browser_tasks.rs", "utf8"),
  readFileSync("src-tauri/src/shellx_browser_task_control.rs", "utf8"),
].join("\n");
const debugApiSource = readFileSync("src-tauri/src/debug_api_browser_state.rs", "utf8");
const browserTypesSource = readFileSync("src/browser/types.ts", "utf8");
const buildMetadataSource = readFileSync("src-tauri/src/build_metadata.rs", "utf8");

function rustHandler(source: string, name: string, nextName: string): string {
  const start = source.indexOf(`pub(crate) async fn ${name}`);
  const end = source.indexOf(`pub(crate) async fn ${nextName}`, start + 1);
  return start >= 0 && end > start ? source.slice(start, end) : "";
}

assert(
  policySource.includes("BROWSER_TASK_AUTONOMY_POLICY_FIXED") &&
    policySource.includes("BrowserAutonomyMode::AssistedAutonomous") &&
    policySource.includes("normalize_browser_task_autonomy") &&
    taskSource.includes("effective_browser_task_autonomy(request.autonomy)") &&
    taskSource.includes("deny_browser_task_autonomy_mutation"),
  "Browser backend enforces one truthful assisted-autonomous task policy",
);
assert(
  debugApiSource.includes("/browser/task/autonomy") &&
    debugApiSource.includes("BROWSER_TASK_AUTONOMY_POLICY_FIXED") &&
    debugApiSource.includes("Err(e) => browser_task_mutation_error_response(e)"),
  "Debug API keeps legacy Browser autonomy routes as stable fixed-policy denials",
);
assert(
  rustHandler(debugApiSource, "browser_task_start_http", "browser_task_finish_http")
    .includes("Err(e) => browser_task_mutation_error_response(e)") &&
    !rustHandler(debugApiSource, "browser_tab_open_http", "browser_tab_focus_http")
      .includes("browser_task_mutation_error_response") &&
    !rustHandler(debugApiSource, "browser_tab_focus_http", "browser_tab_reorder_http")
      .includes("browser_task_mutation_error_response"),
  "fixed-policy error routing is scoped to task mutations, not tab open or focus",
);
assert(
  browserTypesSource.includes('export type BrowserAutonomy = "assistedAutonomous"'),
  "Browser frontend exposes only the enforced autonomy policy",
);
assert(
  buildMetadataSource.includes('"browserFixedAssistedPolicy"'),
  "Browser build metadata advertises fixed assisted policy semantics",
);

if (failures > 0) {
  console.error(`\n${failures} Browser policy assertion(s) failed.`);
  process.exit(1);
}

console.log("\nAll ShellX Browser policy assertions passed.");
