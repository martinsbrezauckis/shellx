// src/lib/tauri-bridge.ts
//
// Tiny helpers that let components running in a plain Chromium / Vite
// dev preview (no Tauri webview, no IPC) degrade gracefully instead of
// throwing `Cannot read properties of undefined (reading 'invoke')`
// or `... reading 'transformCallback'` errors.
//
// Used by:
// - src/App.tsx — event.listen subscription wiring
// - src/components/ConnectionPicker.tsx — connections_list invoke
// - src/components/VaultPanel.tsx — vault_* invokes (if mounted)
// - src/components/Header.tsx — set_permission_mode invoke
//
// Pattern: check `inTauri` before any invoke / listen call. If
// false, render the empty-state UI silently — no console-spam errors,
// no red banners.

/**
 * Returns true if running inside a Tauri webview (where the JS-side
 * IPC bridge exists). Returns false in a plain browser tab (Vite dev,
 * Playwright bridge for visual iteration, Storybook etc).
 *
 * Detection: Tauri 2 attaches `window.__TAURI_INTERNALS__` very early
 * during webview init, before any user JS runs. If it's missing by
 * the time React hooks fire, we're not in Tauri.
 */
export function inTauri(): boolean {
  if (typeof window === "undefined") return false;
  return typeof (window as unknown as { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__ !== "undefined";
}

/**
 * One-line label describing the runtime environment — shown in dev
 * console logs and the chat "running outside Tauri" warning so you
 * always know which lane you're in.
 */
export function runtimeLabel(): string {
  return inTauri() ? "tauri" : "browser";
}
