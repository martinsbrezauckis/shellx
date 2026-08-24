import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CUT_TOOLING_FIXTURES,
  CUT_TOOLING_STATES,
  cutToolingPresentation,
  normalizeDebugCutToolingFixture,
} from "../../src/lib/cut-tooling";

const cutGateway = readFileSync("src-tauri/src/host_mcp/cut_mcp.rs", "utf8");
const cutStatus = readFileSync("src-tauri/src/host_mcp/cut_status.rs", "utf8");
const hostMcp = readFileSync("src-tauri/src/host_mcp.rs", "utf8");
const backend = readFileSync("src-tauri/src/lib.rs", "utf8");
const rightRail = `${readFileSync("src/components/RightRail.tsx", "utf8")}\n${readFileSync("src/components/CutToolingRow.tsx", "utf8")}`;
const plugins = readFileSync("src/components/PluginsModal.tsx", "utf8");
const app = readFileSync("src/App.tsx", "utf8");
const debugApi = readFileSync("src-tauri/src/debug_api.rs", "utf8");
const debugApiUi = readFileSync("src-tauri/src/debug_api_session_state.rs", "utf8");

assert.deepEqual(
  CUT_TOOLING_STATES,
  [
    "checking",
    "ready",
    "installedEditorClosed",
    "notInstalled",
    "unsupportedTarget",
    "unavailableToProvider",
    "unavailable",
  ],
  "Cut Tooling fixtures must cover every durable status state",
);
for (const state of CUT_TOOLING_STATES) {
  const fixture = CUT_TOOLING_FIXTURES[state];
  assert.equal(fixture.status, state, `${state} fixture must retain its exact state marker`);
  assert.equal(fixture.schemaVersion, "shellx.cut.tooling-status.v1");
  assert.notEqual(fixture.detail.trim(), "", `${state} fixture needs an operator-visible explanation`);
  assert.notEqual(cutToolingPresentation(fixture).label, "", `${state} fixture needs a visible status label`);
  assert.equal(normalizeDebugCutToolingFixture(state), state);
}
assert.equal(normalizeDebugCutToolingFixture("clear"), "clear");
assert.equal(normalizeDebugCutToolingFixture("unknown"), null);

const advertisedCutTools =
  cutGateway.includes('"name": "cut_read"') &&
  cutGateway.includes('"name": "cut_act"');
const toolingProjection =
  hostMcp.includes("pub(crate) mod cut_status;") &&
  backend.includes("cut: host_mcp::cut_status::CutToolingStatus") &&
  backend.includes("let cut = host_mcp::cut_status::snapshot_for_session(&session).await;") &&
  rightRail.includes("<CutToolingRow") &&
  rightRail.includes("data-shellx-cut-tooling-row=\"selected-session\"");
const advertisedCutRequiresToolingProjection = (advertised: boolean, projection: boolean): boolean =>
  !advertised || projection;

assert(
  advertisedCutRequiresToolingProjection(advertisedCutTools, toolingProjection),
  "advertised compact Cut tools must have a selected-session Tooling projection",
);
assert(
  !advertisedCutRequiresToolingProjection(advertisedCutTools, false),
  "parity assertion must fail when Cut remains advertised but its Tooling projection is removed",
);
assert(
  advertisedCutRequiresToolingProjection(false, false),
  "non-advertised tools may intentionally have no Tooling row",
);

assert(cutGateway.includes("snapshot_for_host_mcp"), "cut_read action=status must use the shared Cut status service");
assert(cutGateway.includes("into_host_mcp_result"), "cut_read action=status must return the typed Cut status projection");
assert(cutStatus.includes("CutToolingState::UnavailableToProvider"), "provider tooling-off must be distinct from missing Cut");
assert(cutStatus.includes("CutToolingState::UnsupportedTarget"), "sessions without a ShellX host context must be rejected before a Cut probe");
assert(cutStatus.includes("CutTarget::Local | CutTarget::Wsl | CutTarget::Ssh"), "local, WSL, and SSH sessions must share the parent desktop-host Cut projection");
assert(!cutStatus.includes("context.target != CutTarget::Local"), "WSL and SSH must not be treated as unsupported when ShellX Host MCP is available");
assert(backend.includes("remote_transports_inject_session_scoped_http_host_mcp"), "WSL and SSH Cut reachability must remain backed by the tested tab-bound Host MCP transport");
assert(cutStatus.includes("CutToolingState::InstalledEditorClosed"), "installed but closed Cut must stay distinct from not installed");
assert(cutStatus.includes("ShellX never opens Cut automatically."), "operator-only launch invariant must remain explicit");
assert(cutStatus.includes('const CUT_WINDOWS_APP_BASENAME: &str = "shellx-cut.exe";'), "Windows Cut Open must resolve the actual installed shellx-cut.exe sibling");
assert(!cutStatus.includes('join("ShellX Cut.exe")'), "Windows Cut Open must not retain the stale product-label filename");
assert(
  cutStatus.indexOf("async fn snapshot_for_context") < cutStatus.indexOf("fn launch_cut_for_operator"),
  "status polling must be structurally separate from the operator-only launcher",
);
assert(!cutStatus.includes("cut_tool_list("), "Cut status must not fetch or expose the generated Cut catalog");
assert(!cutStatus.includes("search_tool_rows("), "Cut status must not inline generated Cut verb names");

for (const marker of [
  "data-shellx-cut-tooling-row",
  "data-shellx-cut-state",
  "data-shellx-cut-check-sequence",
  "data-shellx-cut-action=\"check\"",
  'data-shellx-cut-action={displayed.canOpen ? "open" : "open-unavailable"}',
]) {
  assert(rightRail.includes(marker), `Right Rail must retain durable Cut selector ${marker}`);
}
assert(rightRail.includes('invoke<CutToolingStatus>("cut_tooling_open"'), "Open must be a deliberate Tauri action");
assert(rightRail.includes('title="Check ShellX Cut status without opening the editor"'), "Check must promise non-launch behavior");
assert(rightRail.includes("Status refreshed for this selected session."), "manual Check must leave one visible session-scoped completion marker");
assert(backend.includes("async fn cut_tooling_open"), "backend must own the explicit Cut Open action");
assert(backend.includes("cut_tooling_open,"), "Cut Open must be registered for the renderer");
assert(!hostMcp.includes("mcp_marketplace"), "built-in Cut status must not be duplicated as a marketplace plugin");
assert(plugins.includes("ShellX Cut video editing"), "Plugins must retain the built-in Cut description");
assert(plugins.includes("Cut actions activate when ShellX Cut is installed and running."), "Plugins and Tools must keep the same readiness expectation");
assert(
  rightRail.includes("CUT_TOOLING_STATES.map((state)")
    && rightRail.includes('data-debug-id={`cut-tooling-state-${state}`}'),
  "each finite Cut state must become its own installed-app visible marker",
);
assert(
  app.includes("normalizeDebugCutToolingFixture(p.debugCutToolingFixture)")
    && app.includes("debugCutToolingFixture={debugCutToolingFixture}")
    && rightRail.includes("if (debugCutToolingFixture || !activeTabId || cutOpening) return;"),
  "the renderer-only Cut fixture must remain bounded and unable to invoke Open",
);
assert(
  debugApi.includes('rename = "debugCutToolingFixture"')
    && debugApiUi.includes('"invalid_debug_cut_tooling_fixture"')
    && debugApiUi.includes("if !crate::isolated_test_instance_requested()"),
  "Cut visual fixtures must remain transient and isolated-test-only",
);

console.log("Cut Tooling parity contracts passed");
