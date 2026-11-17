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
 * The updater check creates a resource from the release manifest. Package
 * signature verification happens during download and installation.
 * If no usable manifest is available, `check` can return a quiet 404; the
 * catch path keeps the UI clean.
 */
import { useEffect, useRef, useState, type JSX } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "../lib/tauri-bridge";
import { updateErrorIsQuiet } from "../lib/update-diagnostics";
import {
  MANUAL_UPDATE_DOWNLOAD_URL,
  resolveUpdateInstallMethod,
  type UpdateInstallMethod,
} from "../lib/update-install-policy";
import { cleanUpdateNotes, firstUpdateNotesUrl } from "../lib/update-notes";
import { UpdateOffer, checkOfferAfterLoad } from "../lib/update-offer";

interface UpdateState {
  available: boolean;
  version?: string;
  body?: string;
  downloading: boolean;
  progress: number; // 0..1
  error: string | null;
  installMethod: UpdateInstallMethod;
}

const INITIAL: UpdateState = {
  available: false,
  downloading: false,
  progress: 0,
  error: null,
  installMethod: "automatic",
};

function openExternal(url: string): void {
  void invoke("open_url_in_browser", { url })
    .catch(() => {
      try { window.open(url, "_blank", "noopener,noreferrer"); } catch { /* ignore */ }
    });
}

export function UpdateBanner(): JSX.Element | null {
  const [state, setState] = useState<UpdateState>(INITIAL);
  const [releaseReceipt, setReleaseReceipt] = useState<string | null>(null);
  const offerRef = useRef<UpdateOffer<Update> | null>(null);
  const displayedOfferRef = useRef<Update | null>(null);
  if (!offerRef.current) offerRef.current = new UpdateOffer<Update>();

  useEffect(() => {
    if (!inTauri()) return; // browser-only preview: no updater plugin
    let cancelled = false;
    const offer = offerRef.current!;

    async function checkOnce(): Promise<void> {
      try {
 // Lazy import — the updater module only works inside Tauri.
        const result = await checkOfferAfterLoad(
          offer,
          async () => (await import("@tauri-apps/plugin-updater")).check,
          () => !cancelled,
        );
        if (cancelled || result.kind === "stale") return;
        if (result.kind === "error") throw result.error;
        if (result.kind === "none") {
          displayedOfferRef.current = null;
          setState(INITIAL);
          return;
        }
        const update = result.update;
        const installMethod = await resolveUpdateInstallMethod();
        if (cancelled || offer.offered !== update) return;
        displayedOfferRef.current = update;
        setState((prev) => ({
          ...prev,
          available: true,
          version: update.version,
          body: cleanUpdateNotes(update.body),
          error: null,
          installMethod,
        }));
      } catch (err: unknown) {
        if (cancelled) return;
 // swallow "no release yet"
 // failures into a silent no-op. The plugin's typical wording is
 // "Could not fetch a valid release JSON from the remote" when
 // the GitHub endpoint 404s (repo not created yet or no release
 // tagged). Network unreachable and missing remote updater JSON
 // fall in the same quiet bucket for startup checks — neither means
 // "there is an update we can't install", only that no usable update
 // is being advertised right now.
 //
 // We still surface SIGNATURE failures + DOWNLOAD failures
 // because those are real operational/security signals. Those
 // strings (`signature`, `verification`, `corrupt`) don't match
 // the swallow regex so they reach the error banner.
        const msg = err instanceof Error ? err.message : String(err);
        if (updateErrorIsQuiet(msg)) {
          offer.clear();
          displayedOfferRef.current = null;
          if (!cancelled) setState(INITIAL);
        } else if (!cancelled) {
          setState((prev) => ({ ...prev, error: msg }));
        }
      }
    }

    void checkOnce();
    const id = window.setInterval(() => void checkOnce(), 30 * 60 * 1000);
    return () => { cancelled = true; clearInterval(id); displayedOfferRef.current = null; offer.clear(); };
  }, []);

  async function install(): Promise<void> {
    const displayedOffer = displayedOfferRef.current;
    const installMethod = await resolveUpdateInstallMethod();
    if (!displayedOffer || offerRef.current?.offered !== displayedOffer) {
      setState((prev) => ({ ...prev, available: false, error: "The offered update changed. Check again." }));
      return;
    }
    if (installMethod === "manual") {
      openExternal(MANUAL_UPDATE_DOWNLOAD_URL);
      setReleaseReceipt("Manual package update opened in the browser.");
      setState((prev) => ({ ...prev, downloading: false, progress: 0, error: null, installMethod }));
      return;
    }
    setState((prev) => ({ ...prev, downloading: true, progress: 0, error: null }));
    try {
      const update = offerRef.current?.beginInstall(displayedOffer);
      if (!update) {
        setState((prev) => ({ ...prev, downloading: false, error: "update vanished mid-flight" }));
        return;
      }
      const { relaunch } = await import("@tauri-apps/plugin-process");
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
    } finally {
      offerRef.current?.finishInstall();
    }
  }

  if (!state.available && !state.error) return null;
  const releaseNotesUrl = firstUpdateNotesUrl(state.body);

  return (
    <div
      role="status"
      data-release-update-receipt="banner"
      data-shellx-release-observe="title"
      title={releaseReceipt ?? "Update status"}
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
          {state.installMethod === "manual" && (
            <span>Installed Linux packages update through their package manager.</span>
          )}
          {releaseNotesUrl && (
            <button
              type="button"
              data-release-update-control="banner-notes"
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
              data-debug-id="update-banner-install"
              data-release-update-control="banner-install"
              onClick={() => void install()}
              style={{
                fontFamily: "var(--sans)",
                fontSize: "var(--fs-ui-sm)",
                background: "var(--accent)",
                color: "var(--ink-on-accent)",
                border: "none",
                borderRadius: "var(--radius-button)",
                padding: "4px 12px",
                cursor: "pointer",
                fontWeight: 500,
              }}
            >
              {state.installMethod === "manual" ? "Download update" : "Install & restart"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
