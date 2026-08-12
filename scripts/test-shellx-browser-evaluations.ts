import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const runtime = read("src-tauri/src/shellx_browser_evaluations.rs");
const model = read("src-tauri/src/shellx_browser_evaluation_model.rs");
const lib = read("src-tauri/src/lib.rs");
const router = read("src-tauri/src/debug_api_browser_artifacts.rs");
const mcp = read("src-tauri/src/mcp_http.rs");
const hostMcp = read("src-tauri/src/host_mcp.rs");
const browserEntry = read("src-tauri/src/host_mcp/browser_entry.rs");
const browserArtifacts = read("src-tauri/src/host_mcp/browser_artifacts.rs");
const browserSpecs = read("src-tauri/src/host_mcp/browser_specs.rs");
const cli = read("scripts/shellx-browser-cli.ts");
const installed = read("scripts/test-shellx-browser-flight-recorder-installed.ts");
const packageJson = read("package.json");

const checks: Array<[string, boolean]> = [
  [
    "evaluation core and model are compiled",
    lib.includes("mod shellx_browser_evaluations;") &&
      lib.includes("mod shellx_browser_evaluation_model;"),
  ],
  [
    "evaluation and rating schemas are versioned",
    runtime.includes('"sx.evaluation.v1"') &&
      runtime.includes('"sx.evaluation-rating.v1"'),
  ],
  [
    "attempt and report budgets are explicit",
    runtime.includes("MAX_EVALUATION_ATTEMPTS: usize = 200") &&
      runtime.includes("MAX_FLIGHT_ARTIFACT_BYTES: u64 = 512 * 1_024") &&
      runtime.includes("MAX_EVALUATION_ARTIFACT_BYTES: usize = 256 * 1_024"),
  ],
  [
    "source artifacts are identity and host-export-receipt checked inside private storage",
    runtime.includes("std::fs::canonicalize") &&
      runtime.includes("artifact digest identity mismatch") &&
      runtime.includes("outside private Flight Recorder storage") &&
      runtime.includes("artifactExportReceiptBound") &&
      runtime.includes("no matching Flight Recorder export receipt"),
  ],
  [
    "missing evidence and safety regressions are fail-closed ratings",
    runtime.includes('"insufficient-evidence"') &&
      runtime.includes('"safety-regression"') &&
    runtime.includes('"unsafe-candidate"') &&
      runtime.includes("incomplete or gapped Flight Recorder evidence") &&
      runtime.includes("attemptOutcomeVerificationRequired") &&
      runtime.includes("unverified-attempt-outcomes"),
  ],
  [
    "report response carries exact artifact identity",
    model.includes("evidence_digest") &&
      model.includes("sha256") &&
      model.includes("BrowserReceipt"),
  ],
  [
    "authenticated Debug API exposes operator-or-owner-scoped evidence routes",
    router.includes('"/browser/evaluations"') &&
      router.includes('"/browser/evidence"') &&
      router.includes("write_evaluation_report_for_agent_session") &&
      router.includes("invalid ShellX MCP caller id"),
  ],
  [
    "compact routed gateway exposes evidence without adding advertised tools",
    browserEntry.includes('"evidence" => tool_browser_evidence') &&
      browserEntry.includes('"flightrecorderexport"') &&
      browserEntry.includes('"evaluationwrite"') &&
      browserSpecs.includes('"name": "browser_evaluation_write"') &&
      browserSpecs.includes('"name": "browser_flight_recorder_export"') &&
      hostMcp.includes('"browser_evaluation_write"') &&
      !mcp.includes("browserEvaluation"),
  ],
  [
    "MCP evidence calls require and propagate the ShellX owner session",
    browserArtifacts.includes("required_browser_evidence_caller") &&
      browserArtifacts.includes("debug_api_get_json_for_caller") &&
      browserArtifacts.includes('"/browser/evaluations"') &&
      browserArtifacts.includes("!evidence_complete"),
  ],
  [
    "CLI exports attempts and fails incomplete evaluations",
    cli.includes('case "flight-recorder-export"') &&
      cli.includes('case "workflow-evaluate"') &&
      cli.includes('"/browser/evaluations"') &&
      cli.includes("objectValue(result)?.evidenceComplete !== true"),
  ],
  [
    "installed pipeline uses the compact MCP gateway and exact CLI artifact identities",
    installed.includes('mcpCall(mcp, "browser_act"') &&
      installed.includes('action: "flightRecorderExport"') &&
      installed.includes('action: "evaluationWrite"') &&
      installed.includes('action: "evidence"') &&
      installed.includes("/browser/settle?taskId") &&
      installed.includes("artifactSha256") &&
      installed.includes("cleanupOwnedBrowserLifecycle") &&
      installed.includes("{ [CALLER_HEADER]: tabId }") &&
      installed.includes("cleanup.errors.length === 0") &&
      packageJson.includes("test:shellx-browser-flight-recorder-installed"),
  ],
];

let failed = false;
for (const [label, ok] of checks) {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failed = true;
    console.error(`  ✗ ${label}`);
  }
}
if (failed) process.exit(1);
console.log("ShellX Browser evaluation core contract passed");
