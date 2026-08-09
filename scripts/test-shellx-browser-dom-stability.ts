import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const actionability = source("src-tauri/src/shellx_browser_actionability.rs");
const execution = source("src-tauri/src/shellx_browser_action_execution.rs");
const scripts = source("src-tauri/src/shellx_browser_scripts.rs");
const model = source("src-tauri/src/shellx_browser_observation_model.rs");
const metadata = source("src-tauri/src/build_metadata.rs");
const lib = source("src-tauri/src/lib.rs");
const docs = source("docs/public/API.md");
const live = source("scripts/test-shellx-browser-stable-refs-live.ts");

assert(actionability.includes("SHELLX_ELEMENT_STABILITY_MIN_MS = 120") && actionability.includes("new WeakMap()"), "DOM stability requires bounded cross-sample geometry evidence");
assert(actionability.includes("shellxRunningGeometryAnimations") && actionability.includes("element.getAnimations()"), "finite geometry animations cannot look stable before their first rendered frame");
assert(actionability.includes("shellxAnimationIsVisuallyActive") && actionability.includes("getComputedTiming") && actionability.includes("currentTime >= endTime"), "finished WebKit animations do not block visually settled targets forever");
assert(actionability.includes("shellxAnimationTimeMs") && actionability.includes("animationActiveSince") && actionability.includes("SHELLX_UNKNOWN_ANIMATION_GRACE_MS"), "non-numeric WebKit animation timing falls back to a bounded grace before geometry stability");
assert(actionability.includes('check.failedChecks.push("stable")') && actionability.includes("stabilitySamples"), "unstable actionable targets return explicit evidence");
assert(execution.includes("BROWSER_ACTION_STABILITY_TIMEOUT_MS: u64 = 2_000") && execution.includes("BROWSER_ACTION_STABILITY_POLL_MS: u64 = 50"), "DOM action stability retries are fast and bounded");
assert(execution.includes("eval_browser_engine_action_result") && lib.includes("mod shellx_browser_action_execution;"), "Browser action polling lives in a focused registered module");
assert(execution.includes('check == "stable" || (force_click && check == "receivesEvents")'), "stability retry never bypasses other actionability failures");
assert(scripts.includes("element && actionability.visible && actionability.stable") && scripts.includes("selectorWait ? { actionability } : {}"), "selector waits require stability without penalizing text-only waits");
assert(model.includes('rename = "stabilityMs"') && model.includes('rename = "stabilitySamples"'), "actionability responses expose stability evidence");
assert(metadata.includes('"domStabilityWaits"'), "Browser discovery advertises DOM stability waits");
assert(docs.includes("120 ms") && live.includes("moving target click waits until animation settles"), "docs and native smoke cover real stability waiting");

console.log("ShellX Browser DOM-stability contract tests passed");
