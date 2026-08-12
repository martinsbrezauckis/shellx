import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  browserHistoryClearActionLabel,
  browserHistoryEntriesForScope,
  browserHistoryScopeForEntry,
} from "../src/browser/historyScope";
import type { BrowserHistoryEntry } from "../src/browser/types";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

const entries = [
  { historyId: "user", profileId: "personal", taskId: null, url: "https://example.test/user", visitedAtMs: 1 },
  { historyId: "blank-task", profileId: "personal", taskId: " ", url: "https://example.test/blank", visitedAtMs: 2 },
  { historyId: "task-personal", profileId: "personal", taskId: "task-1", url: "https://example.test/task", visitedAtMs: 3 },
  { historyId: "agent", profileId: "agent-work", taskId: null, url: "https://example.test/agent", visitedAtMs: 4 },
] satisfies BrowserHistoryEntry[];

console.log("\n=== ShellX Browser history scope contracts ===");

assert.equal(browserHistoryScopeForEntry(entries[0]!), "user");
assert.equal(browserHistoryScopeForEntry(entries[1]!), "user");
assert.equal(browserHistoryScopeForEntry(entries[2]!), "agent");
assert.equal(browserHistoryScopeForEntry(entries[3]!), "agent");
assert.deepEqual(browserHistoryEntriesForScope("user", entries).map((entry) => entry.historyId), ["user", "blank-task"]);
assert.deepEqual(browserHistoryEntriesForScope("agent", entries).map((entry) => entry.historyId), ["task-personal", "agent"]);
assert.deepEqual(browserHistoryEntriesForScope("all", entries).map((entry) => entry.historyId), entries.map((entry) => entry.historyId));
assert.equal(browserHistoryClearActionLabel("user"), "Clear User history");
assert.equal(browserHistoryClearActionLabel("agent"), "Clear Agent history");
assert.equal(browserHistoryClearActionLabel("all"), "Clear all history");
console.log("  ✓ TypeScript classifies Personal entries without a task as User and every other entry as Agent");

const tsScope = source("src/browser/historyScope.ts");
const rustScope = source("src-tauri/src/shellx_browser_settings_model.rs");
const rustBackend = source("src-tauri/src/shellx_browser_history.rs");
const rustCommand = source("src-tauri/src/shellx_browser_window_runtime.rs");
const rustTests = source("src-tauri/tests/shellx_browser.rs");
const api = source("src/browser/api.ts");
const app = source("src/components/ShellxBrowserApp.tsx");
const clear = source("src/browser/historyClear.ts");
const sidecar = source("src/browser/components/BrowserHistorySidecar.tsx");
const css = source("src/browser/browserLayout.css");
const nativeHistoryDriver = source("scripts/release-drivers/ui-control-owned-browser-history.ts");

assert(tsScope.includes('entry.profileId === USER_DEFAULT_PROFILE_ID && !entry.taskId?.trim()'));
assert(rustScope.includes('profile_id == "personal"') && rustScope.includes(".map(str::trim)"));
assert(rustScope.includes("pub enum BrowserHistoryScope") && rustScope.includes("Self::User") && rustScope.includes("Self::Agent") && rustScope.includes("Self::All"));
assert(rustBackend.includes("scope.matches(&entry.profile_id, entry.task_id.as_deref())"));
assert(rustBackend.includes('json!({ "scope": scope, "removed": removed })'));
assert(rustCommand.includes("request: BrowserClearHistoryRequest")
  && rustCommand.includes("clear_browser_history_from_operator(")
  && rustCommand.includes("request.scope,"));
assert(rustTests.includes("browser_clear_history_user_scope_preserves_agent_history"));
assert(rustTests.includes("browser_clear_history_agent_scope_preserves_user_history"));
assert(rustTests.includes("browser_clear_history_all_scope_removes_mixed_history"));
console.log("  ✓ Rust uses the same exact classification predicate and returns scope plus removed-count receipts");

assert(api.includes('invoke<BrowserHistoryClearReceipt>("shellx_browser_clear_history", { request: { scope } })'));
assert(app.includes("clearScopedBrowserHistory({"));
assert(clear.includes("clearBrowserHistoryCommand(scope)") && clear.includes("receiptScope !== scope"));
assert(!app.includes("window.confirm"));
assert(!sidecar.includes("window.confirm"));
assert(sidecar.includes('role="alertdialog"') && sidecar.includes("useModalFocus("));
assert(sidecar.includes('data-dialog-initial-focus="true"') && sidecar.includes('data-debug-id="shellx-browser-history-clear-confirm"'));
assert(sidecar.includes('data-debug-id="shellx-browser-clear-all-history"'));
assert(css.includes(".shellx-browser-history-confirmation"));
assert(!nativeHistoryDriver.includes("acceptReleaseSurfaceInstalledInputAlert"));
assert(nativeHistoryDriver.includes("shellx-browser-history-clear-confirmation"));
assert(nativeHistoryDriver.includes("const CLEAR_ALL") && nativeHistoryDriver.includes("requireMixedHistory(connection"));
assert(nativeHistoryDriver.includes('expectedDomains: ["127.0.0.1"]'));
assert(nativeHistoryDriver.includes("requireAllClearReceipt(connection, mixedHistory.length)"));
assert(nativeHistoryDriver.includes('receipt.evidence?.scope === "all"'));
console.log("  ✓ ShellX-owned confirmation binds its visible scope, payload, receipt status, focus trap, Escape route, and native driver");

console.log("PASS ShellX Browser history scope contracts");
