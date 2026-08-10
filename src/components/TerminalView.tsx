/**
 * src/components/TerminalView.tsx — reusable xterm.js mount
 *
 * Role
 * Single source of truth for mounting xterm.js into a host <div>,
 * spawning an operator PTY in the Rust TerminalRegistry, and
 * forwarding keystrokes + output bytes between them.
 *
 * The component owns its PTY lifecycle: `pty_create` on mount,
 * `pty_write`/`pty_resize` while active, and `pty_kill` on unmount.
 *
 * Dependencies
 * xterm — terminal renderer (v5 API)
 * @xterm/addon-fit — fit-to-container resizing
 * @xterm/addon-web-links — clickable links in output
 * @tauri-apps/api/core, /event — invoke + event listening
 *
 * Callers
 * - BottomPanel.tsx
 *
 * Lifecycle
 * - Mount: instantiate Terminal + FitAddon + WebLinksAddon, attach to
 * DOM, then invoke pty_create.
 * - Subscribe to pty-output + pty-exit events filtered by
 * (tabId, terminalId). Append bytes via term.write.
 * - Forward term.onData → pty_write.
 * - Unmount: drop listeners, kill the PTY, and dispose xterm.
 *
 * Non-Tauri fallback
 * When `window.__TAURI_INTERNALS__` is undefined, render a tiny note
 * instead of attempting `invoke` calls.
 */
import { useEffect, useRef, type JSX } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "xterm/css/xterm.css";

/** Wire payload for the `pty-output` Tauri event. Matches PtyOutputEvent
 * in terminal.rs. `data` arrives as a JSON array of byte values which
 * Tauri's serde-json codec produces from Rust's `Vec<u8>`. */
interface PtyOutputPayload {
  tabId: string;
  terminalId: string;
  data: number[];
}

/** Wire payload for the `pty-exit` Tauri event. */
interface PtyExitPayload {
  tabId: string;
  terminalId: string;
  exitCode?: number | null;
  signal?: string | null;
}

/** Detect whether we're running inside the Tauri webview. The PTY commands
 * only exist there; in the plain Vite dev server (`pnpm dev`) they would
 * throw. */
export function isTauri(): boolean {
  return typeof window !== "undefined"
    && typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
       !== "undefined";
}

export interface TerminalViewProps {
 /** Stable per-session identifier. Keys the PTY in the registry. */
  tabId: string;
}

/** xterm.js mount for the operator-facing bottom-panel terminal. */
export function TerminalView({ tabId }: TerminalViewProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const terminalIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    if (!hostRef.current) return;
    if (!tabId) return;
    const host = hostRef.current;
 /* pick up the runtime --fs-mono CSS var set by
 * lib/settings.applyTheme so the user's chat-font slider also resizes
 * terminals. Falls back to 13 if the var isn't a parseable px (e.g.
 * tests / non-Tauri renders). */
    const readMonoPx = (): number => {
      try {
        const raw = getComputedStyle(document.documentElement)
          .getPropertyValue("--fs-mono").trim();
        const n = parseFloat(raw);
        return Number.isFinite(n) && n > 0 ? n : 13;
      } catch { return 13; }
    };
    const term = new Terminal({
      theme: {
        background: "var(--bg)",
        foreground: "#e8e8e8",
        cursor: "#e8e8e8",
        selectionBackground: "rgba(255,255,255,0.18)",
      },
      fontFamily: "ui-monospace, 'JetBrains Mono', Menlo, Monaco, 'Cascadia Code', 'Source Code Pro', Consolas, monospace",
      fontSize: readMonoPx(),
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 10_000,
      allowProposedApi: true,
      convertEol: false,
      disableStdin: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    try { fit.fit(); } catch { /* container not laid out yet */ }
    termRef.current = term;

 /* live-resize the canvas when the slider moves. applyTheme
 * dispatches `shellx-font-change` on every patch; we mirror
 * fontSize and re-fit so cols/rows recompute to the new cell size. */
    const onFontChange = (e: Event) => {
      const detail = (e as CustomEvent<{ monoPx?: number }>).detail;
      const nextPx = (detail && typeof detail.monoPx === "number")
        ? detail.monoPx
        : readMonoPx();
      try {
        term.options.fontSize = nextPx;
        fit.fit();
      } catch { /* terminal disposed or container unlaid */ }
    };
    window.addEventListener("shellx-font-change", onFontChange);

    const myTabId = tabId;
    let disposed = false;
    let unlistenOutput: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;

    (async () => {
      try {
        const cols = term.cols;
        const rows = term.rows;
        const activeId = await invoke<string>("pty_create", {
          tabId: myTabId,
          cols,
          rows,
        });
        if (disposed) {
          void invoke("pty_kill", { tabId: myTabId, terminalId: activeId }).catch(() => {});
          return;
        }
        terminalIdRef.current = activeId;

        unlistenOutput = await listen<PtyOutputPayload>("pty-output", (evt) => {
          const p = evt.payload;
          if (p.tabId !== myTabId || p.terminalId !== activeId) return;
          term.write(new Uint8Array(p.data));
        });

        unlistenExit = await listen<PtyExitPayload>("pty-exit", (evt) => {
          const p = evt.payload;
          if (p.tabId !== myTabId || p.terminalId !== activeId) return;
          const codePart = p.exitCode != null ? ` (exit ${p.exitCode})` : "";
          term.write(`\r\n\x1b[2m[process exited${codePart}]\x1b[0m\r\n`);
        });

        term.onData((data) => {
          if (disposed || !terminalIdRef.current) return;
          const bytes = Array.from(new TextEncoder().encode(data));
          void invoke("pty_write", {
            tabId: myTabId,
            terminalId: terminalIdRef.current,
            data: bytes,
          }).catch((err) => {
            console.warn("[TerminalView] pty_write failed:", err);
          });
        });
      } catch (err) {
        console.error("[TerminalView] mount failed:", err);
        if (!disposed) {
          term.write(`\r\n\x1b[31m[mount failed: ${String(err)}]\x1b[0m\r\n`);
        }
      }
    })();

 // ResizeObserver -> FitAddon.fit -> pty_resize, debounced 50ms.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        try { fit.fit(); } catch { return; }
        const id = terminalIdRef.current;
        if (id && !disposed) {
          void invoke("pty_resize", {
            tabId: myTabId,
            terminalId: id,
            cols: term.cols,
            rows: term.rows,
          }).catch(() => { /* transient resize failures tolerable */ });
        }
      }, 50);
    });
    ro.observe(host);

    return () => {
      disposed = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      ro.disconnect();
      window.removeEventListener("shellx-font-change", onFontChange);
      if (unlistenOutput) unlistenOutput();
      if (unlistenExit) unlistenExit();
      const id = terminalIdRef.current;
      if (id) {
        void invoke("pty_kill", { tabId: myTabId, terminalId: id }).catch(() => {});
      }
      terminalIdRef.current = null;
      term.dispose();
      termRef.current = null;
    };
  }, [tabId]);

  if (!isTauri()) {
    return (
      <div className="tab-placeholder">
        (Terminal requires the Tauri runtime — run via <code>pnpm tauri:dev</code>.)
      </div>
    );
  }

  return (
    <div className="terminal-tab">
      <div ref={hostRef} className="terminal-host" />
    </div>
  );
}
