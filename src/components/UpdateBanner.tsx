/**
 * src/components/UpdateBanner.tsx — Tauri updater UI .
 *
 * Polls the configured updater endpoint at startup + every 30 min while
 * the app is running. When an update is available, renders a thin
 * banner above the header with "Update vX.Y.Z available · Install".
 *
 * Endpoint + pubkey are configured in src-tauri/tauri.conf.json under
 * `plugins.updater`. The Rust side verifies signatures; this component
 * just drives the UI flow.
 *
 * Backend pipeline (out of scope for this file):
 * 1. CI builds the Windows .exe + macos + linux artifacts
 * 2. CI signs them with TAURI_SIGNING_PRIVATE_KEY (~/.shellx-keys/updater.key)
 * 3. CI uploads to GitHub Releases (.exe, .msi, .AppImage, .dmg + latest.json)
 * 4. App polls the manifest URL; sees new version; this banner appears
 *
 * If a development build has no published update manifest yet, `check`
 * can return a quiet 404; the catch path no-ops so the UI stays clean.
 */
import { useEffect, useState, type JSX } from "react";
import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "../lib/tauri-bridge";
import { updateErrorIsQuiet } from "../lib/update-diagnostics";
import { cleanUpdateNotes, firstUpdateNotesUrl } from "../lib/update-notes";

interface UpdateState {
  available: boolean;
  version?: string;
  body?: string;
  downloading: boolean;
  progress: number; // 0..1
  error: string | null;
}

const INITIAL: UpdateState = {
  available: false,
  downloading: false,
  progress: 0,
  error: null,
};

function openExternal(url: string): void {
  void invoke("open_url_in_browser", { url })
    .catch(() => {
      try { window.open(url, "_blank", "noopener,noreferrer"); } catch { /* ignore */ }
    });
}

export function UpdateBanner(): JSX.Element | null {
  const [state, setState] = useState<UpdateState>(INITIAL);

  useEffect(() => {
    if (!inTauri()) return; // browser-only preview: no updater plugin
    let cancelled = false;

    async function checkOnce(): Promise<void> {
      try {
 // Lazy import — the updater module only works inside Tauri.
        const { check } = await import("@tauri-apps/plugin-updater");
        const update = await check();
        if (cancelled || !update) return;
        setState((prev) => ({
          ...prev,
          available: true,
          version: update.version,
          body: cleanUpdateNotes(update.body),
          error: null,
        }));
      } catch (err: unknown) {
 // swallow "no release yet"
 // failures into a silent no-op. The plugin's typical wording is
 // "Could not fetch a valid release JSON from the remote" when
 // the GitHub endpoint 404s (repo not created yet or no release
 // tagged). Network unreachable + manifest-parse errors fall in
 // the same bucket — none of these mean "there is an update we
 // can't reach", they mean "no update is available right now".
 //
 // We still surface SIGNATURE failures + DOWNLOAD failures
 // because those are real operational/security signals. Those
 // strings (`signature`, `verification`, `corrupt`) don't match
 // the swallow regex so they reach the error banner.
        const msg = err instanceof Error ? err.message : String(err);
        if (!updateErrorIsQuiet(msg)) {
          setState((prev) => ({ ...prev, error: msg }));
        }
      }
    }

    void checkOnce();
    const id = window.setInterval(() => void checkOnce(), 30 * 60 * 1000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  async function install(): Promise<void> {
    setState((prev) => ({ ...prev, downloading: true, progress: 0, error: null }));
    try {
      const [{ check }, { relaunch }] = await Promise.all([
        import("@tauri-apps/plugin-updater"),
        import("@tauri-apps/plugin-process"),
      ]);
      const update = await check();
      if (!update) {
        setState((prev) => ({ ...prev, downloading: false, error: "update vanished mid-flight" }));
        return;
      }
      let total = 0;
      let downloaded = 0;
      await update.downloadAndInstall((evt) => {
        if (evt.event === "Started") total = evt.data.contentLength ?? 0;
        if (evt.event === "Progress") {
          downloaded += evt.data.chunkLength;
          if (total > 0) setState((prev) => ({ ...prev, progress: downloaded / total }));
        }
      });
 // Tauri restarts the app after install completes.
      await relaunch();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setState((prev) => ({ ...prev, downloading: false, error: msg }));
    }
  }

  if (!state.available && !state.error) return null;
  const releaseNotesUrl = firstUpdateNotesUrl(state.body);

  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        padding: "8px 16px",
        background: state.error ? "rgba(239, 68, 68, 0.08)" : "rgba(34, 197, 94, 0.08)",
        borderBottom: "1px solid var(--hairline)",
        fontFamily: "var(--sans)",
        fontSize: "var(--fs-ui-sm)",
        color: state.error ? "var(--err)" : "var(--ink-2)",
      }}
    >
      {state.error ? (
        <>
          <span>Update check failed:</span>
          <code style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{state.error}</code>
        </>
      ) : (
        <>
          <span>
            <strong style={{ color: "var(--ink)" }}>Update v{state.version}</strong> available.
          </span>
          {releaseNotesUrl && (
            <button
              type="button"
              onClick={() => openExternal(releaseNotesUrl)}
              style={{
                fontFamily: "var(--sans)",
                fontSize: "var(--fs-ui-sm)",
                background: "transparent",
                color: "var(--accent)",
                border: "1px solid color-mix(in srgb, var(--accent), transparent 70%)",
                borderRadius: "var(--radius-button)",
                padding: "3px 10px",
                cursor: "pointer",
                fontWeight: 500,
              }}
            >
              Release notes
            </button>
          )}
          <span style={{ flex: 1 }} />
          {state.downloading ? (
            <span>
              Installing… {Math.round(state.progress * 100)}%
            </span>
          ) : (
            <button
              type="button"
              onClick={() => void install()}
              style={{
                fontFamily: "var(--sans)",
                fontSize: "var(--fs-ui-sm)",
                background: "var(--accent)",
                color: "#0a0a0a",
                border: "none",
                borderRadius: "var(--radius-button)",
                padding: "4px 12px",
                cursor: "pointer",
                fontWeight: 500,
              }}
            >
              Install &amp; restart
            </button>
          )}
        </>
      )}
    </div>
  );
}
