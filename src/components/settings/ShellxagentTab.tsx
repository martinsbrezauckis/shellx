/**
 * src/components/settings/ShellxagentTab.tsx — Settings → shellXagent.
 *
 * shellXagent is the orchestration API surface for external agents
 * to drive shellX end-to-end via HTTP+WS on 127.0.0.1:<bound-port>.
 * Default port 5757; falls back through 5759/5761/5763/5765 when the
 * preferred port is taken. This tab manages the bearer token AND
 * surfaces the actually-bound port so users can copy a working URL.
 *
 * Backend Tauri commands:
 * - shellxagent_token_read → current 32-hex-char token
 * - shellxagent_token_regenerate → rotate + persist
 * - get_bound_ports → { debugApi, mcpHttp } actual ports
 *
 * Rotation takes effect immediately: the auth middleware re-reads
 * `~/.shellx/shellxagent.token` on every request, so orchestrators
 * just reload the file to pick up the new value.
 *
 * Uses the shared `.settings-row`/`.settings-label`/`.settings-input`/
 * `.settings-pill` primitives so visual rhythm matches the other tabs.
 */
import { useEffect, useState, type JSX } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Default port the debug-api server prefers — used as a display fallback
 * ONLY when the Tauri command hasn't returned yet or the server isn't
 * bound. The actually-bound port may differ (env override or
 * orphan-socket fallback to 5759/5761/5763/5765). */
const DEFAULT_DEBUG_API_PORT = 5757;

const inTauri = (): boolean =>
  typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== "undefined";

async function invokeCmd<T>(cmd: string): Promise<T> {
  if (!inTauri()) {
    throw new Error("Tauri context required");
  }
  return invoke<T>(cmd);
}

function maskToken(t: string): string {
  if (t.length < 8) return "•".repeat(t.length);
  return `${t.slice(0, 4)}${"•".repeat(t.length - 8)}${t.slice(-4)}`;
}

/** Shape returned by the `get_bound_ports` Tauri command. Either field
 * is null when the corresponding server hasn't completed bind yet. */
interface BoundPorts {
  debugApi: number | null;
  mcpHttp: number | null;
}

export function ShellxagentTab(): JSX.Element {
  const [token, setToken] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [justRotated, setJustRotated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
 // Actual port the debug-api server bound on — may differ from the
 // 5757 default when env-overridden or when an orphan socket forced
 // a fallback step (5759/5761/5763/5765).
  const [boundPort, setBoundPort] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const t = await invokeCmd<string>("shellxagent_token_read");
        if (!cancelled) setToken(t);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    void (async () => {
      try {
        const ports = await invokeCmd<BoundPorts>("get_bound_ports");
        if (!cancelled && typeof ports?.debugApi === "number") {
          setBoundPort(ports.debugApi);
        }
      } catch {
 // Tauri unavailable (Vite dev in plain browser) or command not
 // registered — leave boundPort null, render falls back to the
 // default-port display.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

 // auto-mask the token after 60 s of Reveal mode.
 // Without this, an idle Settings → shellXagent panel exposes the
 // full 32-char token on screen indefinitely — a screen-share /
 // over-the-shoulder leak. The 60 s window matches the time a user
 // typically needs to copy + paste somewhere.
  useEffect(() => {
    if (!revealed) return undefined;
    const timer = window.setTimeout(() => setRevealed(false), 60_000);
    return () => window.clearTimeout(timer);
  }, [revealed]);

  async function regenerate() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const t = await invokeCmd<string>("shellxagent_token_regenerate");
      setToken(t);
      setRevealed(true);
      setJustRotated(true);
 // Auto-mask after 30s — the user has had time to copy.
      window.setTimeout(() => setJustRotated(false), 30_000);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function copyToClipboard() {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
 // auto-clear clipboard after 30 s so a
 // clipboard-history manager can't replay the token long after
 // the user paste-and-forget. We only clear if the clipboard
 // STILL holds our token (defensive — user may have copied
 // something else in the meantime).
      window.setTimeout(async () => {
        try {
          const current = await navigator.clipboard.readText();
          if (current === token) {
            await navigator.clipboard.writeText("");
          }
        } catch {
 // readText may be denied without user gesture; swallow.
        }
      }, 30_000);
    } catch (e) {
      setError(`clipboard: ${String(e)}`);
    }
  }

 // Display string for the masked / revealed / loading token.
  const displayed =
    token == null
      ? "loading…"
      : revealed || justRotated
      ? token
      : maskToken(token);

 // Display the actually-bound port when known; otherwise show the
 // default with a "(default)" hint so the user understands the value
 // isn't a live read. The bound port may be 5759/5761/5763/5765 when
 // an orphan socket forced a fallback.
  const displayedPort = boundPort ?? DEFAULT_DEBUG_API_PORT;
  const portIsLive = boundPort !== null;

  return (
    <div className="settings-tab-body">
      <p className="settings-tab-hint">
        Orchestration API for external agents. Lets a CI bot or another
        orchestrator drive shellX over HTTP+WS on
        <code> 127.0.0.1:{displayedPort}</code>
        {portIsLive ? null : " (default — server not yet bound)"}.
      </p>

      <div className="settings-row">
        <label className="settings-label">Bearer token</label>
        <code
          className="settings-input"
          style={{
 // Mono needed for the hex token; intentionally not size
 // override — inherits the unified 12px.
            fontFamily: "var(--mono)",
            userSelect: "all",
          }}
        >
          {displayed}
        </code>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="settings-pill"
            onClick={() => setRevealed((v) => !v)}
            disabled={!token}
          >
            {revealed ? "Hide" : "Reveal"}
          </button>
          <button
            type="button"
            className="settings-pill"
            onClick={copyToClipboard}
            disabled={!token}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>

      <div className="settings-row">
        <label className="settings-label">Rotate token</label>
        <span className="settings-suffix">
          {justRotated
            ? "✓ Rotated. Old token invalidated immediately."
            : "Issues a new 32-char hex token and persists to disk."}
        </span>
        <button
          type="button"
          className="settings-pill"
          onClick={regenerate}
          disabled={loading}
          style={{
            borderColor: "var(--fg-error, #f55)",
            color: "var(--fg-error, #f55)",
          }}
        >
          {loading ? "Regenerating…" : "Regenerate"}
        </button>
      </div>

      {error && (
        <div role="alert" className="vault-error">
          {error}
        </div>
      )}

      <h4>Where it&apos;s used</h4>
      <ul className="settings-help-list">
        <li>
          Token file: <code>~/.shellx/shellxagent.token</code> (auto-
          migrated from legacy <code>debug.token</code> on first boot).
        </li>
        <li>
          Bound-port file: <code>~/.shellx/debug-api.port</code>
          {" "}— external drivers read this to discover the live port
          (default 5757; falls back through 5759/5761/5763/5765).
        </li>
        <li>
          Bearer header: <code>Authorization: Bearer &lt;token&gt;</code>
        </li>
        <li>
          Endpoints span every UI surface — see <code>docs/API.md</code> in
          the repo for the full route inventory.
        </li>
        <li>
          Override via env var <code>GROK_SHELL_DEBUG_SECRET</code> for CI.
        </li>
      </ul>
    </div>
  );
}
