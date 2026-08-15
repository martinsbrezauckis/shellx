import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let failures = 0;

function assert(condition: boolean, label: string): void {
  console.log(`  ${condition ? "✓" : "✗"} ${label}`);
  if (!condition) failures += 1;
}

function source(path: string): string {
  return readFileSync(resolve(path), "utf8");
}

console.log("\n=== ShellX Browser developer inspection source contracts ===");

const inspection = source("src-tauri/src/shellx_browser_developer_inspection.rs");
const adapter = source("src-tauri/src/debug_api_browser_developer_inspection.rs");
const routes = source("src-tauri/src/debug_api_browser.rs");
const entry = source("src-tauri/src/host_mcp/browser_entry.rs");
const specs = source("src-tauri/src/host_mcp/browser_specs.rs");
const releaseFixture = source("scripts/release-drivers/browser-teach-developer-fixture.ts");

assert(
  inspection.includes("sx.browserDeveloperInspection.v1")
    && inspection.includes("32 * 1024")
    && inspection.includes("3 * 1024"),
  "inspection declares the versioned 32 KiB response and 3 KiB MCP budgets",
);
assert(
  inspection.includes('method: "ShellX.developerInspect".to_string()')
    && inspection.includes("developer_inspection_script()")
    && !inspection.includes("BrowserDeveloperInspectionRequest {\n    pub expression"),
  "inspection uses a fixed Developer Mode-gated capture rather than caller-provided CDP",
);
assert(
  inspection.includes("safe_origin_path")
    && inspection.includes("sanitize_required_text")
    && inspection.includes("redact_if_credential_pattern")
    && inspection.includes("looks_like_private_path"),
  "inspection source sanitizes URLs, credential-shaped strings, and private paths",
);
assert(
  inspection.includes("browser_protected_values_for_task")
    && inspection.includes("withheldSections")
    && inspection.includes("nativeEngineUnavailable"),
  "protected values and unavailable engine state fail closed",
);
assert(
  adapter.includes('"/browser/developer/inspect"')
    && adapter.includes("caller id is required")
    && adapter.includes("requires taskId")
    && adapter.includes("ensure_browser_request_authority_for_task_id"),
  "Debug API route requires an authenticated caller-owned task",
);
assert(
  routes.includes("browser_developer_inspection_routes"),
  "Debug API Browser router mounts the focused inspection adapter",
);
assert(
  entry.includes('"developerInspect",')
    && entry.includes('"developerinspect" => tool_browser_developer_inspect')
    && !entry.includes('BROWSER_ACT_ACTIONS: &[&str] = &[\n    "developerInspect"'),
  "developer inspection is routed only through browser_read",
);
assert(
  specs.includes("developerInspect returns a 3072-byte sanitized developer summary"),
  "compact Browser schema documents the bounded read action without adding a tool",
);
assert(
  releaseFixture.includes('body.status !== "blocked"')
    && releaseFixture.includes("truncation.developerModeRequired !== true"),
  "installed release proof expects the shipped blocked status and Developer Mode truncation flag",
);

if (failures > 0) {
  console.error(`\n${failures} Browser developer inspection source contract assertion(s) failed.`);
  process.exit(1);
}

console.log("\nPASS ShellX Browser developer inspection source contracts");
