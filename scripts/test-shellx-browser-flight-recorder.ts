import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const router = read("src-tauri/src/debug_api_browser_artifacts.rs");
const runtime = read("src-tauri/src/shellx_browser_flight_recorder.rs");
const sanitization = read("src-tauri/src/shellx_browser_flight_recorder_sanitization.rs");
const model = read("src-tauri/src/shellx_browser_flight_recorder_model.rs");
const lib = read("src-tauri/src/lib.rs");
const installedGate = read("scripts/test-shellx-browser-flight-recorder-installed.ts");

const checks: Array<[string, boolean]> = [
  [
    "Flight Recorder runtime and sanitization boundary are compiled",
    lib.includes("mod shellx_browser_flight_recorder;") &&
      lib.includes("mod shellx_browser_flight_recorder_sanitization;"),
  ],
  [
    "authenticated Debug API exposes the export route",
    router.includes('"/browser/flight-recorder/export"') &&
      router.includes("browser_mcp_caller_id(&headers)") &&
      router.includes("export_flight_recorder_for_agent_session"),
  ],
  ["attempt bundle schema is versioned", runtime.includes('"sx.flightRecorder.v1"')],
  [
    "selection and artifact budgets are explicit",
    runtime.includes("MAX_FLIGHT_RECEIPTS: usize = 160") &&
      runtime.includes("MAX_FLIGHT_EVENTS: usize = 320") &&
      runtime.includes("MAX_FLIGHT_ARTIFACT_BYTES: usize = 512 * 1_024"),
  ],
  [
    "response carries truncation and identity receipts",
    model.includes("dropped_events") &&
      model.includes("dropped_receipts") &&
      model.includes("sha256") &&
      model.includes("BrowserReceipt"),
  ],
  [
    "recorder reports durable sequence, retention gaps, and honest completeness",
    runtime.includes('"sourceSequence": receipt.sequence') &&
      runtime.includes('"retentionDroppedEvents"') &&
      runtime.includes('"sanitizerLossCount"') &&
      runtime.includes('"gapCount"') &&
      runtime.includes('"evidenceComplete"') &&
      runtime.includes('"selectedStrictlyIncreasing"'),
  ],
  [
    "recorder exposes operation, timing, and task-local lineage limits",
    runtime.includes('"UNTAGGED_INVOKE"') &&
      runtime.includes('"timeToFirstActionMs"') &&
      runtime.includes('"unaccountedMs": Value::Null') &&
      runtime.includes('"lineageStatus": "task-local"') &&
      runtime.includes('"parentTaskId": Value::Null'),
  ],
  [
    "raw browser state classes are explicitly excluded",
    runtime.includes('"cookies": false') &&
      runtime.includes('"authorizationHeaders": false') &&
      runtime.includes('"localStorageValues": false') &&
    runtime.includes('"networkBodies": false'),
  ],
  [
    "URL path values are excluded from recorder artifacts",
    runtime.includes('"httpPathValuesRetained": false') &&
      sanitization.includes('"/[redacted-path]"'),
  ],
  [
    "cross-host installed gate accepts only a loopback fixture tunnel",
    installedGate.includes("SHELLX_FLIGHT_RECORDER_FIXTURE_URL") &&
      installedGate.includes('url.hostname !== "127.0.0.1"') &&
      installedGate.includes('url.protocol !== "http:"'),
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
console.log("ShellX Browser Flight Recorder contract passed");
