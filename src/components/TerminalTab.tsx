/**
 * src/components/TerminalTab.tsx — frontend
 *
 * Role
 * Bottom-panel terminal tab. Owns a fresh PTY per session tab via the
 * shared `<TerminalView mode="owned"/>` xterm.js mount. The PTY lives
 * in `src-tauri/src/terminal.rs`'s TerminalRegistry; this component is
 * just the visual + lifecycle binding.
 *
 * xterm.js mount logic has been extracted
 * into the reusable `<TerminalView/>` so the chat-embedded ACP
 * terminal view in ChatOutput.tsx can share it. This file is now a
 * thin wrapper.
 *
 * Callers
 * BottomPanel.tsx mounts <TerminalTab tabId={activeTabId}/> when the
 * user is on the "Terminal" tab and an `activeTabId` is set.
 */
import { type JSX } from "react";
import { TerminalView } from "./TerminalView";

/**
 * Bottom-panel terminal view (owned-mode PTY).
 *
 * @param tabId stable per-session identifier — keys the PTY in the Rust
 * registry so each session tab gets its own shell.
 */
export function TerminalTab({ tabId }: { tabId: string }): JSX.Element {
 // Owned mode: TerminalView calls pty_create on mount, pty_kill on unmount.
 // ResizeObserver + FitAddon make the shell fill the panel.
  return <TerminalView tabId={tabId} />;
}
