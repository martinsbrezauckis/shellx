/**
 * src/components/TerminalView.tsx — reusable xterm.js mount
 *
 * Role
 * Single source of truth for mounting xterm.js into a host <div>,
 * spawning (or attaching to) a PTY in the Rust TerminalRegistry, and
 * forwarding keystrokes + output bytes between them.
 *
 * Two render modes:
 * - "owned" (default, used by <TerminalTab/> in the bottom panel):
 * calls `pty_create` on mount and `pty_kill` on unmount. Owns
 * the PTY lifecycle.
 * - "attach" (used by ChatOutput's inline ACP-terminal view):
 * binds to an existing terminalId via `pty_attach` (which returns
 * the current ring snapshot for instant replay) and listens to
 * `pty-output` / `pty-exit` events. Does NOT spawn or kill — that
 * is the ACP agent's job via terminal/create + terminal/release.
 *
 * Dependencies
 * xterm — terminal renderer (v5 API)
 * @xterm/addon-fit — fit-to-container resizing
 * @xterm/addon-web-links — clickable links in output
 * @tauri-apps/api/core, /event — invoke + event listening
 *
 * Callers
 * - TerminalTab.tsx (mode="owned")
 * - ChatOutput.tsx (mode="attach", attachOnly prop)
 * - Future: BottomPanel "ACP" tab strip rendering attached views
 * for ACP-origin terminals.
 *
 * Lifecycle
 * - Mount: instantiate Terminal + FitAddon + WebLinksAddon, attach to
 * DOM. In owned mode: invoke pty_create. In attach mode: invoke
 * pty_attach to fetch snapshot, then term.write it.
 * - Subscribe to pty-output + pty-exit events filtered by
 * (tabId, terminalId). Append bytes via term.write.
 * - In owned mode: forward term.onData → pty_write.
 * - In attach mode: forward keystrokes only if `readOnly === false`,
 * allowing the chat-embedded view to be interactive when the user
 * wants to type into the agent's shell.
 * - Unmount: drop listeners, dispose xterm. Owned mode also calls
 * pty_kill; attach mode leaves the registry record alone.
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

/** Wire payload for the `pty-exit` Tauri event. added the
 * exitCode / signal fields so chat-embedded views can render an
 * exit-status footer matching what grok sees via `terminal/output`. */
interface PtyExitPayload {
  tabId: string;
  terminalId: string;
  exitCode?: number | null;
  signal?: string | null;
}

/** Snapshot returned by `pty_attach`. */
interface PtyAttachSnapshot {
  tabId: string;
  terminalId: string;
  output: string;
  truncated: boolean;
  exited: boolean;
  origin: "user" | "acp";
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
 /** Mode-A only: existing ACP-origin terminal_id to attach to. When
 * set, the component does NOT call pty_create / pty_kill. */
  terminalId?: string;
 /** When true, skip pty_create/pty_kill and bind to the provided
 * terminalId via pty_attach. Implies the terminalId prop is required. */
  attachOnly?: boolean;
 /** Disable input forwarding. When true, term.onData is not piped
 * into pty_write. Useful for chat-embedded views where the user
 * shouldn't be able to type into the agent's shell. Defaults to false
 * even in attach mode — a typed interactive view is the better UX. */
  readOnly?: boolean;
 /** Optional explicit row count cap (visible rows). Useful for the
 * inline chat view which wants ~24 rows, not "fill container". */
  initialRows?: number;
}

/**
 * Shared xterm.js mount that backs both the bottom-panel terminal tab
 * and the chat-embedded ACP terminal view. See the file header for mode
 * semantics.
 */
export function TerminalView(props: TerminalViewProps): JSX.Element {
  const { tabId, terminalId, attachOnly = false, readOnly = false, initialRows } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const terminalIdRef = useRef<string | null>(terminalId ?? null);

  useEffect(() => {
    if (!isTauri()) return;
    if (!hostRef.current) return;
    if (!tabId) return;
 // Attach mode requires a terminalId.
    if (attachOnly && !terminalId) return;

    const host = hostRef.current;
 /* pick up the runtime --fs-mono CSS var set by
 * Settings.applyTheme so the user's chat-font slider also resizes
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
        background: "#0a0a0a",
        foreground: "#e8e8e8",
        cursor: "#e8e8e8",
        selectionBackground: "rgba(255,255,255,0.18)",
      },
      fontFamily: "ui-monospace, 'JetBrains Mono', Menlo, Monaco, 'Cascadia Code', 'Source Code Pro', Consolas, monospace",
      fontSize: readMonoPx(),
      lineHeight: 1.2,
      cursorBlink: !readOnly,
      scrollback: 10_000,
      allowProposedApi: true,
      convertEol: false,
      ...(typeof initialRows === "number" ? { rows: initialRows } : {}),
      disableStdin: readOnly,
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
        let activeId: string;

        if (attachOnly) {
          activeId = terminalId!;
          terminalIdRef.current = activeId;
 // Pull the existing ring contents so the user sees scrollback
 // even when the agent populated the PTY before our mount.
          try {
            const snap = await invoke<PtyAttachSnapshot>("pty_attach", {
              tabId: myTabId,
              terminalId: activeId,
            });
            if (disposed) return;
            if (snap.output) term.write(snap.output);
            if (snap.exited) {
              term.write(`\r\n\x1b[2m[process exited — output may continue if released later]\x1b[0m\r\n`);
            }
          } catch (err) {
 // Registry may not know this terminalId yet (race with
 // terminal/create on the agent side). Subscribe to events
 // anyway — the bytes will start flowing once create lands.
            console.warn("[TerminalView] pty_attach failed (will still subscribe):", err);
          }
        } else {
 // Owned mode: spawn a brand-new PTY for the bottom-panel tab.
          const cols = term.cols;
          const rows = term.rows;
          const id = await invoke<string>("pty_create", {
            tabId: myTabId,
            cols,
            rows,
          });
          if (disposed) {
            void invoke("pty_kill", { tabId: myTabId, terminalId: id }).catch(() => {});
            return;
          }
          activeId = id;
          terminalIdRef.current = id;
        }

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

 // Wire keystrokes only when not read-only.
        if (!readOnly) {
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
        }
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
 // Owned mode: pty_kill drops the registry record (User-origin).
 // Attach mode: leave the record alone — only `terminal/release`
 // from the ACP agent should remove it.
      if (!attachOnly && id) {
        void invoke("pty_kill", { tabId: myTabId, terminalId: id }).catch(() => {});
      }
      terminalIdRef.current = null;
      term.dispose();
      termRef.current = null;
    };
  }, [tabId, terminalId, attachOnly, readOnly, initialRows]);

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
