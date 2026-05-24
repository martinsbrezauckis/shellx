/**
 * src/components/settings/AboutTab.tsx — build identity + ownership +
 * update controls. Single compact panel with version, build, author,
 * homepage, X handle, and the update action.
 *
 * Sources:
 * - Version: imported from `package.json` (Vite tree-shakes the
 * rest of the JSON).
 * - Tip commit: `__APP_GIT_TIP__` injected via `vite.config.ts`
 * (short HEAD hash, "unknown" when git is unavailable at build).
 * - Updater state: `tauri-plugin-updater::check` — same plugin
 * drives the UpdateBanner in App.tsx.
 *
 * External links — IMPORTANT: in a Tauri WebView, `<a target="_blank">`
 * silently does nothing (no popup, no system-browser handoff). Every
 * link to a public URL must route through the `open_url_in_browser`
 * Tauri command instead. We use a single `openExternal` helper for
 * that, with a fall-through to `window.open` for browser-only dev
 * mode (`pnpm dev` outside Tauri).
 *
 * "Open in shellX" buttons route through `window.shellxOpenFilePreview`
 * (set up in App.tsx) so in-repo docs render in the FilePreviewModal
 * instead of an external browser tab.
 */
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import pkg from "../../../package.json";
import { SafeMarkdownLink } from "../../lib/markdown-links";
import { cleanUpdateNotes } from "../../lib/update-notes";
import { ShellIcon } from "../icons";

/**
 * Open `url` in the user's external default browser via the Tauri
 * `open_url_in_browser` command (registered in lib.rs). Falls back to
 * `window.open` in dev / browser-only mode.
 *
 * Tauri WebView does NOT honor `target="_blank"` — we must explicitly
 * hand the URL to the OS. Without this, clicking GitHub / Issues / X
 * / Homepage anchors produces no visible effect at all.
 */
function openExternal(url: string): void {
  void invoke("open_url_in_browser", { url })
    .catch(() => {
      try { window.open(url, "_blank", "noopener,noreferrer"); } catch { /* ignore */ }
    });
}

const VERSION = (pkg as { version?: string }).version ?? "0.0.0";
const TIP_COMMIT: string =
  typeof __APP_GIT_TIP__ === "string" ? __APP_GIT_TIP__ : "unknown";
const AUTHOR_EMAIL = "martins.brezauckis@gmail.com";

interface UpdateState {
  kind: "idle" | "checking" | "available" | "current" | "installing" | "error";
  remoteVersion?: string;
  message?: string;
  progress?: number;
}

interface BoundPorts {
  debugApi: number | null;
  mcpHttp: number | null;
}

export function AboutTab(): JSX.Element {
  const [updateState, setUpdateState] = useState<UpdateState>({ kind: "idle" });
  const [ports, setPorts] = useState<BoundPorts | null>(null);
  const [emailCopied, setEmailCopied] = useState(false);

 // #333: read the actually-bound ports from the Rust backend. With the
 // #311 orphan-socket fallback the running ports may differ from the
 // statically-known defaults (5757 / 5760); surface the real values so
 // the user (and any external tooling reading from here) doesn't have
 // to guess.
  useEffect(() => {
    void invoke<BoundPorts>("get_bound_ports")
      .then((p) => setPorts(p))
      .catch(() => { /* command absent on older shellX builds */ });
  }, []);

  async function checkForUpdates(): Promise<void> {
    setUpdateState({ kind: "checking" });
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update) {
        setUpdateState({
          kind: "available",
          remoteVersion: update.version,
          message: cleanUpdateNotes(update.body) || `Update v${update.version} is available.`,
        });
      } else {
        setUpdateState({
          kind: "current",
          message: "You're on the latest release.",
        });
      }
    } catch (e) {
      setUpdateState({
        kind: "error",
        message: `Update check failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  async function installUpdate(): Promise<void> {
    setUpdateState((prev) => ({ ...prev, kind: "installing", progress: 0 }));
    try {
      const [{ check }, { relaunch }] = await Promise.all([
        import("@tauri-apps/plugin-updater"),
        import("@tauri-apps/plugin-process"),
      ]);
      const update = await check();
      if (!update) {
        setUpdateState({ kind: "current", message: "You're on the latest release." });
        return;
      }
      let total = 0;
      let downloaded = 0;
      await update.downloadAndInstall((evt) => {
        if (evt.event === "Started") total = evt.data.contentLength ?? 0;
        if (evt.event === "Progress") {
          downloaded += evt.data.chunkLength;
          if (total > 0) {
            setUpdateState((prev) => ({
              ...prev,
              kind: "installing",
              progress: downloaded / total,
            }));
          }
        }
      });
      await relaunch();
    } catch (e) {
      setUpdateState({
        kind: "error",
        message: `Update install failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

 //  switched from window.shellxOpenFilePreview (which routed
 // through the filesystem-backed FilePreviewModal and tripped the
 // path-scope check on bare filenames) to a global event consumed by
 // App.tsx, which mounts BuiltinDocModal with curated in-app docs.
 // The docs live in src/lib/builtin-docs.ts as TypeScript constants
 // so they ship inside the installer with no filesystem dependency.
  function openBuiltinDoc(docId: "features" | "readme" | "changelog"): void {
    try {
      window.dispatchEvent(new CustomEvent("shellx:open-builtin-doc", { detail: { docId } }));
    } catch { /* no-op */ }
  }

  function copyAuthorEmail(): void {
    try { void navigator.clipboard.writeText(AUTHOR_EMAIL); } catch { /* no-op */ }
    setEmailCopied(true);
    window.setTimeout(() => setEmailCopied(false), 1500);
  }

  return (
    <div className="settings-tab-body about-tab">
      <div className="about-brand">
        <div className="about-name">shellX</div>
        <div className="about-tag">
          Cross-platform desktop shell for Grok Build and any ACP-speaking agent
        </div>
      </div>

      <dl className="about-grid">
        <dt>Version</dt>
        <dd>
          <code>{VERSION}</code>{" "}
          <button
            type="button"
            className="settings-pill"
            onClick={() => void checkForUpdates()}
            disabled={updateState.kind === "checking" || updateState.kind === "installing"}
            style={{ marginLeft: 8 }}
          >
            {updateState.kind === "checking" ? "Checking…"
              : updateState.kind === "installing" ? `Installing ${Math.round((updateState.progress ?? 0) * 100)}%`
                : "Check for updates"}
          </button>
          {updateState.kind === "available" && (
            <button
              type="button"
              className="settings-pill"
              onClick={() => void installUpdate()}
              style={{ marginLeft: 8 }}
            >
              Install &amp; restart
            </button>
          )}
          {updateState.message && (
            <div
              className="settings-tab-hint"
              style={{
                margin: "4px 0 0",
                color:
                  updateState.kind === "available"
                    ? "var(--accent)"
                    : updateState.kind === "error"
                      ? "var(--danger)"
                      : "var(--ink-3)",
              }}
            >
              {updateState.kind === "available" ? (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    p: ({ children }) => <span>{children}</span>,
                    a: ({ href, children }) => <SafeMarkdownLink href={href}>{children}</SafeMarkdownLink>,
                  }}
                >
                  {updateState.message}
                </ReactMarkdown>
              ) : updateState.message}
            </div>
          )}
        </dd>

        <dt>Build</dt>
        <dd>
          <code>{TIP_COMMIT}</code>{" "}
          <span className="settings-tab-hint" style={{ marginLeft: 4 }}>
            ({import.meta.env.MODE})
          </span>
        </dd>

        <dt>Author</dt>
        <dd>
          Martins Brezauckis <code>{AUTHOR_EMAIL}</code>{" "}
          <button
            type="button"
            className="settings-pill"
            onClick={copyAuthorEmail}
            style={{ marginLeft: 8 }}
          >
            {emailCopied ? "Copied" : "Copy email"}
          </button>
        </dd>

        <dt>Homepage</dt>
        <dd>
          <a
            href="#"
            onClick={(e) => { e.preventDefault(); openExternal("https://theshellx.com"); }}
            className="about-link"
          >
            <span>theshellx.com</span>
            <ShellIcon name="external-link" size={13} />
          </a>
        </dd>

        <dt>X / Twitter</dt>
        <dd>
          <a
            href="#"
            onClick={(e) => { e.preventDefault(); openExternal("https://x.com/theshellx"); }}
            className="about-link"
          >
            <span>@theshellx</span>
            <ShellIcon name="external-link" size={13} />
          </a>
        </dd>

        <dt>License</dt>
        <dd>MIT</dd>

        <dt>Bound ports</dt>
        <dd>
          {ports ? (
            <code>
              shellXagent :{ports.debugApi ?? "?"} · MCP :{ports.mcpHttp ?? "?"}
            </code>
          ) : (
            <span className="settings-tab-hint">(query pending)</span>
          )}
        </dd>
      </dl>

      <div className="about-links" style={{ marginTop: 12 }}>
        <button
          type="button"
          className="settings-pill"
          onClick={() => openBuiltinDoc("features")}
          title="Read the shellX features overview"
        >
          <ShellIcon name="file" size={13} />
          <span>Features</span>
        </button>
        <button
          type="button"
          className="settings-pill"
          onClick={() => openBuiltinDoc("readme")}
          title="Read the shellX quick-start guide"
        >
          <ShellIcon name="file" size={13} />
          <span>Quick start</span>
        </button>
        <a
          href="#"
          onClick={(e) => { e.preventDefault(); openExternal("https://github.com/MartinsBrezauckis/shellx"); }}
          className="settings-pill"
        >
          <span>GitHub</span>
          <ShellIcon name="external-link" size={13} />
        </a>
        <a
          href="#"
          onClick={(e) => { e.preventDefault(); openExternal("https://github.com/MartinsBrezauckis/shellx/issues"); }}
          className="settings-pill"
        >
          <span>Issues</span>
          <ShellIcon name="external-link" size={13} />
        </a>
        <button
          type="button"
          className="settings-pill"
          onClick={() => openBuiltinDoc("changelog")}
          title="Read bundled release notes"
        >
          <ShellIcon name="file" size={13} />
          <span>Changelog</span>
        </button>
      </div>

      <p className="about-fineprint" style={{ marginTop: 16 }}>
        Settings and secrets are stored at <code>~/.shellx/</code> (Linux/macOS) or{" "}
        <code>%USERPROFILE%\.shellx\</code> (Windows). Vault values are encrypted
        with chacha20poly1305 using a master key kept in your OS keyring (or a
        fallback keyfile when the keyring is unavailable). xAI auth uses the
        OAuth bearer from <code>~/.grok/auth.json</code> by default — no separate
        API key required.
      </p>
    </div>
  );
}
