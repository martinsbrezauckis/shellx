import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const identity = source("src-tauri/src/shellx_browser_element_identity.rs");
const identityScript = identity.split("#[cfg(test)]", 1)[0] ?? identity;
const targets = source("src-tauri/src/shellx_browser_element_targets.rs");
const actionResults = source("src-tauri/src/shellx_browser_action_results.rs");
const actionScript = source("src-tauri/src/shellx_browser_action_script.rs");
const actionability = source("src-tauri/src/shellx_browser_actionability.rs");
const actions = source("src-tauri/src/shellx_browser_actions.rs");
const scripts = source("src-tauri/src/shellx_browser_scripts.rs");
const model = source("src-tauri/src/shellx_browser_observation_model.rs");
const control = source("src-tauri/src/shellx_browser_control.rs");
const browser = source("src-tauri/src/shellx_browser.rs");
const tabs = source("src-tauri/src/shellx_browser_tabs.rs");
const lib = source("src-tauri/src/lib.rs");
const live = source("scripts/test-shellx-browser-debug-api.ts");

assert(identity.includes("shellxElementStableRefId") && identity.includes("shellxElementFingerprint"), "element identity is isolated in a reusable script module");
assert(identity.includes("shellxElementDomPath") && identity.includes("shellxElementShadowPath"), "identity metadata includes bounded DOM and shadow paths");
assert(!identityScript.includes("element.value"), "fingerprints never read mutable control values or secrets");
assert(targets.includes("expected_fingerprint: candidate.fingerprint.clone()"), "ref resolution carries the observed fingerprint into native control");
assert(actionResults.includes("preserve_raw_observation_selectors") && targets.includes("or_else(|| candidate.selector.clone())"), "redacted observations retain private selectors for ref replay");
assert(targets.includes("pub fn resolve_engine_selector") && targets.includes("pub(crate) fn resolve_engine_target") && lib.includes("mod shellx_browser_element_targets;"), "element target resolution lives in a focused module");
assert(browser.includes("tab_observations: BTreeMap<String, BrowserObservation>") && actionResults.includes("state.tab_observations.insert") && targets.includes("state.tab_observations.get") && actions.includes("request.browser_tab_id.clone()") && tabs.includes("state.tab_observations.remove(&tab.browser_tab_id)"), "taskless user tabs cache and resolve observed refs without an agent task");
assert(actionability.includes('"staleRef"') && actionability.includes('failedChecks.push("fingerprint")'), "control blocks changed ref identities with structured staleRef evidence");
assert(scripts.includes("staleRefResult(verifyActionability)"), "verify rejects a changed observed identity before evaluating expectations");
assert(scripts.includes("targetActionability") && scripts.includes("request.action, null"), "table extraction validates the observed container identity separately from its table descendant");
assert(actionScript.includes('rename = "expectedFingerprint"') && actionScript.includes("BROWSER_ELEMENT_IDENTITY_SCRIPT") && actionScript.includes("BROWSER_ELEMENT_ACTIONABILITY_SCRIPT"), "native control payload injects the expected fingerprint and shared identity/actionability logic");
assert(model.includes("pub fingerprint: Option<String>") && model.includes("pub fingerprint_matches: Option<bool>"), "public Browser models expose ref identity and mismatch evidence");
assert(control.includes("The observed ref is stale"), "step summaries tell agents to re-observe stale refs");
assert(live.includes("unchanged controls keep the same deterministic ref") && live.includes("changed element identity blocks an old observation ref"), "native Debug API smoke proves stable and stale ref behavior");

console.log("ShellX Browser stable-ref contract tests passed");
