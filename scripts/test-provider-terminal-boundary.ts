import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const acp = readFileSync("src-tauri/src/acp.rs", "utf8");
const terminal = readFileSync("src-tauri/src/terminal.rs", "utf8");
const backend = readFileSync("src-tauri/src/lib.rs", "utf8");
const terminalView = readFileSync("src/components/TerminalView.tsx", "utf8");
const bottomPanel = readFileSync("src/components/BottomPanel.tsx", "utf8");
const chatOutput = readFileSync("src/components/ChatOutput.tsx", "utf8");

assert.match(acp, /m if m\.starts_with\("terminal\/"\)/);
assert.match(acp, /reject_provider_terminal_method\(/);
assert.match(acp, /const PROVIDER_TERMINAL_ERROR_CODE: i32 = -32601/);
for (const method of ["create", "output", "wait_for_exit", "kill", "release"]) {
  assert.doesNotMatch(acp, new RegExp(`"terminal/${method}"\\s*=>`));
}
assert.doesNotMatch(acp, /crate::terminal::acp_/);

for (const retired of [
  "TerminalOrigin",
  "TerminalOpenedEvent",
  "pub async fn acp_create",
  "pub async fn acp_output",
  "pub async fn acp_wait_for_exit",
  "pub async fn acp_kill",
  "pub async fn acp_release",
  "pub async fn pty_attach",
]) {
  assert.equal(terminal.includes(retired), false, `retired provider terminal symbol remains: ${retired}`);
}

for (const command of ["pty_create", "pty_write", "pty_resize", "pty_kill"]) {
  assert(backend.includes(`crate::terminal::${command}`), `operator command remains registered: ${command}`);
  assert(terminalView.includes(`"${command}"`), `operator TerminalView still invokes: ${command}`);
}
assert.equal(backend.includes("crate::terminal::pty_attach"), false);
assert.equal(terminalView.includes("pty_attach"), false);
assert(bottomPanel.includes("<LazyTerminalView tabId={sessionTabId} />"));
assert.equal(
  /setTimeout\(preloadTerminalView/.test(bottomPanel),
  false,
  "Terminal dependencies must not preload on every workspace start",
);
assert(
  bottomPanel.includes("onPointerEnter={preloadTerminalView}")
    && bottomPanel.includes("onFocus={preloadTerminalView}"),
  "Terminal dependencies should preload only from explicit pointer or keyboard intent",
);
assert.equal(bottomPanel.includes("terminal-opened"), false);
assert.equal(bottomPanel.includes("ACP terminal"), false);
assert.equal(chatOutput.includes("attachOnly"), false);

console.log("Provider terminal boundary tests passed");
