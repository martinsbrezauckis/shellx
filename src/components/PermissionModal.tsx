/**
 * src/components/PermissionModal.tsx — synchronous Confirm-mode gate
 * for `terminal/create` requests from grok.
 *
 * . Replaces the prior fire-and-forget
 * `permission-request` event (which let grok's spawn proceed regardless
 * of what the user clicked). The Rust handler in acp.rs now blocks on a
 * `tokio::sync::oneshot::Receiver<bool>` keyed by request_id; this
 * component renders the modal that produces the bool.
 *
 * Wire:
 * 1. App.tsx mounts <PermissionModal /> at the top level (so any
 * tab's request can pop the modal, even when the user is on
 * another tab — the event's _meta.tabId carries that context).
 * 2. The component subscribes to the `permission-request` Tauri
 * channel and renders when a `scope: "terminal/create"` payload
 * arrives with a `request_id`.
 * 3. On Allow / Deny / Esc / outside-click the component invokes
 * `resolve_permission_request(request_id, allow)`.
 *
 * Default-Deny focused: per the user's standing rules, the Deny button
 * holds the initial focus so a "just press Enter" reflex declines a
 * borderline request rather than approving it.
 *
 * Reentrancy: while one modal is open we DROP any incoming
 * permission-request with a different request_id. The dropped request
 * stays pending on the Rust side and will time out at 60s. Real-world
 * grok rarely emits concurrent terminal/create in Confirm mode, so a
 * simple drop is preferable to a queue UI that no design has yet.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Shape of the `permission-request` payload emitted from acp.rs when
 * Confirm mode hits a `terminal/create`. The channel also carries a
 * legacy fire-and-forget shape (scope only, no request_id); we render
 * only the new synchronous-gate shape — `request_id` set AND
 * `scope === "terminal/create"`. */
interface PermissionRequestPayload {
  request_id?: string;
  scope?: string;
  command?: string;
  args?: string[];
  cwd?: string | null;
  env?: Array<{ name: string; value: string }> | string[];
}

interface PendingRequest {
  requestId: string;
  command: string;
  args: string[];
  cwd: string | null;
 /** Normalized env display: "NAME=VALUE" or just "NAME" when the
 * payload carries names only (legacy event shape). */
  env: string[];
}

/** Normalize env: Rust ships `[{name, value}, ...]`; legacy was
 * `[name, ...]`. Both render safely. */
function normalizeEnv(
  raw: PermissionRequestPayload["env"],
): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    if (typeof entry === "string") return entry;
    if (entry && typeof entry === "object" && "name" in entry) {
      const name = String(entry.name ?? "");
      const value = entry.value;
      return value === undefined || value === null
        ? name
        : `${name}=${String(value)}`;
    }
    return "";
  }).filter((s) => s.length > 0);
}

export function PermissionModal(): JSX.Element | null {
  const [pending, setPending] = useState<PendingRequest | null>(null);
 /** Ref-mirror of pending.requestId so the event listener (registered
 * once on mount) can read the current value without re-subscribing
 * on every state change. */
  const pendingIdRef = useRef<string | null>(null);
  useEffect(() => { pendingIdRef.current = pending?.requestId ?? null; }, [pending]);

 /** Ref to the Deny button so we can focus it on mount. Default-Deny
 * posture: Enter / Space dismisses with deny. */
  const denyBtnRef = useRef<HTMLButtonElement | null>(null);

 // Subscribe to the permission-request channel once on mount. The
 // cancelled flag closes a race: if the effect cleanup runs before
 // `listen` resolves, the .then unlistens the freshly-returned
 // handle instead of leaking it.
  useEffect(() => {
    const inTauri = typeof (window as any).__TAURI_INTERNALS__ !== "undefined";
    if (!inTauri) return; // No-op in browser/Playwright bridge.

    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    listen<PermissionRequestPayload>("permission-request", (event) => {
      const p = event.payload;
      if (!p || p.scope !== "terminal/create") return;
      if (typeof p.request_id !== "string") return; // legacy non-blocking shape
      if (pendingIdRef.current) return; // drop while one is already open
      setPending({
        requestId: p.request_id,
        command: String(p.command ?? ""),
        args: Array.isArray(p.args) ? p.args.map(String) : [],
        cwd: typeof p.cwd === "string" ? p.cwd : null,
        env: normalizeEnv(p.env),
      });
    }).then((un) => {
      if (cancelled) {
        try { un(); } catch { /* no-op */ }
      } else {
        unlisten = un;
      }
    }).catch((err) => {
 // listen can fail if Tauri internals aren't ready; log + survive
 // so the rest of the app doesn't blank-screen on a transient init.
 // eslint-disable-next-line no-console
      console.warn("[PermissionModal] listen() failed:", err);
    });
    return () => {
      cancelled = true;
      if (unlisten) {
        try { unlisten(); } catch { /* no-op */ }
      }
    };
  }, []);

 // Auto-focus Deny when the modal opens. requestAnimationFrame so the
 // button is mounted before we focus.
  useEffect(() => {
    if (!pending) return;
    const id = requestAnimationFrame(() => {
      denyBtnRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [pending]);

 /** Resolve and close. `allow=true` → spawn proceeds; `false` → Rust
 * returns -32001 to grok and the spawn is skipped. */
  const resolve = useCallback((allow: boolean) => {
    const id = pending?.requestId;
    if (!id) return;
 // Optimistically close so a slow IPC roundtrip doesn't keep the
 // dialog frozen. Even if the invoke errors, the dialog should not
 // re-open — the request has had its chance.
    setPending(null);
    void invoke<boolean>("resolve_permission_request", {
      requestId: id,
      allow,
    }).catch((err) => {
 // Logged but otherwise non-fatal — the Rust side will time out
 // on its own after 60s and treat as Deny.
 // eslint-disable-next-line no-console
      console.warn("[PermissionModal] resolve invoke failed:", err);
    });
  }, [pending]);

 // Esc → Deny. Mounted only while the modal is open so other Esc
 // handlers (HelpModal, CommandPalette) don't double-fire.
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        resolve(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, resolve]);

  if (!pending) return null;

  const argsDisplay = pending.args.length > 0 ? pending.args.join(" ") : "";

  return (
 // Outside-click → Deny (matches the spec). stopPropagation on the
 // inner modal prevents a click inside from bubbling out to the
 // backdrop and immediately closing the dialog.
    <div className="modal-backdrop" onClick={() => resolve(false)}>
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="permission-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="permission-modal-title">grok wants to run a shell command</h3>
        <p style={{ color: "var(--ink-2)", margin: "8px 0 12px" }}>
          Autonomy is set to <strong>Confirm</strong>. Review the command
          below before allowing.
        </p>

        <div className="modal-section" style={{ marginBottom: 8 }}>
          <div style={{
            fontFamily: "var(--mono)",
            fontSize: 12,
            background: "var(--surface-2)",
            border: "1px solid var(--hairline-2)",
            borderRadius: 4,
            padding: "8px 10px",
            wordBreak: "break-all",
          }}>
            <div><strong>{pending.command}</strong>{argsDisplay ? ` ${argsDisplay}` : ""}</div>
            {pending.cwd && (
              <div style={{ marginTop: 6, color: "var(--ink-3)" }}>
                cwd: {pending.cwd}
              </div>
            )}
            {pending.env.length > 0 && (
              <div style={{ marginTop: 6, color: "var(--ink-3)" }}>
                env: {pending.env.join(" ")}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
 {/* Default focus is Deny per the spec. We also place it
              first in tab order. */}
          <button
            ref={denyBtnRef}
            type="button"
            className="pact"
            onClick={() => resolve(false)}
          >
            Deny
          </button>
          <button
            type="button"
            className="pact pact-edit"
            onClick={() => resolve(true)}
          >
            Allow
          </button>
        </div>
        <div className="modal-hint" style={{ marginTop: 10, fontSize: "var(--fs-ui-xs)" }}>
          Press <kbd style={{
            background: "var(--surface-2)",
            border: "1px solid var(--hairline-2)",
            padding: "2px 6px",
            borderRadius: 3,
            fontFamily: "var(--mono)",
            color: "var(--ink-2)",
            fontSize: 12,
          }}>Esc</kbd> or click outside to deny. Auto-deny after 60s.
        </div>
      </div>
    </div>
  );
}
