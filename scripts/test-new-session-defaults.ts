import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { normalizeSettings } from "../src/lib/settings";
import {
  isUntouchedNewSession,
  newSessionWorkingFolder,
} from "../src/lib/new-session-defaults";

const root = resolve(import.meta.dirname, "..");

const normalized = normalizeSettings({
  defaultAgentId: "codex-cli",
  defaultWorkingFolder: "  C:\\work\\shellx  ",
});
assert.equal(normalized.defaultAgentId, "codex-cli");
assert.equal(normalized.defaultWorkingFolder, "C:\\work\\shellx");

for (const providerId of ["grok", "codex-cli", "claude-code", "antigravity-cli"] as const) {
  assert.equal(normalizeSettings({ defaultAgentId: providerId }).defaultAgentId, providerId);
}
assert.equal(normalizeSettings({ defaultAgentId: "unknown-provider" }).defaultAgentId, null);
assert.equal(normalizeSettings({ defaultWorkingFolder: "C:\\work\u0000bad" }).defaultWorkingFolder, "");
assert.equal(normalizeSettings({ defaultWorkingFolder: "x".repeat(4097) }).defaultWorkingFolder, "");

assert.equal(newSessionWorkingFolder("C:\\Users\\User", {
  defaultAgentId: null,
  defaultWorkingFolder: "",
}), "C:\\Users\\User");
assert.equal(newSessionWorkingFolder("C:\\Users\\User", {
  defaultAgentId: "grok",
  defaultWorkingFolder: "D:\\Projects\\Current",
}), "D:\\Projects\\Current");

assert.equal(isUntouchedNewSession({ sessionId: null, title: "new session" }), true);
assert.equal(isUntouchedNewSession({ sessionId: "provider-session", title: "new session" }), false);
assert.equal(isUntouchedNewSession({ firstMessageMs: 1, title: "new session" }), false);
assert.equal(isUntouchedNewSession({ sessionId: null, title: "Renamed before send" }), false);

const app = readFileSync(resolve(root, "src/App.tsx"), "utf8");
const settingsUi = readFileSync(resolve(root, "src/components/settings/GeneralTab.tsx"), "utf8");
const workspaceCss = readFileSync(resolve(root, "src/styles/app-workspace.css"), "utf8");
const settingsBackend = readFileSync(resolve(root, "src-tauri/src/debug_api_history_settings.rs"), "utf8");
const shellxCommandDriverTest = readFileSync(
  resolve(root, "scripts/test-release-surface-shellx-command-webdriver.ts"),
  "utf8",
);

assert(app.includes("newTabEntry(cwd, autonomy, settings)"));
assert(app.includes("newTabEntry(\"\", \"bypassPermissions\", settings)"));
assert(app.includes("newTabEntry(recoveredCwd, autonomy, NO_NEW_SESSION_DEFAULTS)"));
assert(app.includes("isUntouchedNewSession(tab)"));
assert(app.includes("agentId: defaults.defaultAgentId"));
assert(settingsUi.includes('id="settings-default-agent"'));
assert(settingsUi.includes('data-debug-id="settings-default-working-folder-choose"'));
assert(settingsUi.includes("Choose each time"));
assert(settingsUi.includes("Use the last folder"));
assert(workspaceCss.includes(".settings-font-row > .settings-input"));
assert(workspaceCss.includes(".settings-font-row > .settings-pill"));
assert(workspaceCss.includes("white-space: nowrap"));
assert(settingsBackend.includes('"defaultAgentId": null'));
assert(settingsBackend.includes('"defaultWorkingFolder": ""'));
assert(!shellxCommandDriverTest.includes(
  "local ShellX commands must resolve before provider availability or interjection gating",
));

console.log("New-session default settings tests passed");
