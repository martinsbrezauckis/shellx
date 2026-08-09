import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const observations = source("src-tauri/src/shellx_browser_observations.rs");
const results = source("src-tauri/src/shellx_browser_action_results.rs");
const model = source("src-tauri/src/shellx_browser_observation_model.rs");
const output = source("src-tauri/src/host_mcp/browser_output.rs");
const metadata = source("src-tauri/src/build_metadata.rs");
const docs = source("docs/public/API.md");
const live = source("scripts/test-shellx-browser-stable-refs-live.ts");

assert(observations.includes("BROWSER_OBSERVATION_DELTA_REF_LIMIT: usize = 40"), "observation delta ref ids have a shared hard bound");
assert(observations.includes("hash_field(&mut hasher, &observation.text)") && observations.includes("field.value.as_deref()"), "snapshot ids cover text and redacted field values");
assert(observations.includes("browser_observation_delta") && observations.includes("updated_ref_ids"), "observation processing computes structured ref deltas");
assert(results.match(/finalize_browser_observation\(&mut observation/g)?.length === 2, "task and taskless observations both attach deltas");
assert(model.includes("pub struct BrowserObservationDelta") && model.includes("pub delta: Option<BrowserObservationDelta>"), "Browser observation model exposes optional bounded deltas");
assert(output.includes("refDelta=+") && output.includes("changeKinds="), "Host MCP compact summaries surface observation changes");
assert(metadata.includes('"observationDeltas"'), "Browser discovery advertises observation deltas");
assert(docs.includes("addedRefIds") && docs.includes("updatedRefIds"), "Browser API docs describe bounded delta fields");
assert(live.includes("unchanged observation reports changed:false") && live.includes("changed observation reports replacement refs"), "native live smoke covers unchanged and changed deltas");

console.log("ShellX Browser observation-delta contract tests passed");
