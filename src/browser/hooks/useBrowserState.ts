import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";

import { inTauri } from "../../lib/tauri-bridge";
import { browserApiGet, browserDebugApiBase, getBrowserDebugToken } from "../api";
import {
  normalizeBrowserDebugHighlights,
  normalizeBrowserDebugSurface,
  sameBrowserDebugHighlights,
} from "../debugBridge";
import type { BrowserProfile, BrowserState, BrowserTab } from "../types";
import type { DebugHighlightRequest } from "../../components/DebugHighlightOverlay";

export type BrowserRightPanelPatch = "chat" | "requests" | "actions" | "errors";

interface UseBrowserStateOptions {
  address: string;
  profileId: string;
  onPendingStartUrl: (url: string) => void;
  onMissingProfile: (profiles: BrowserProfile[]) => void;
  onLiveTabsChanged: (tabs: BrowserTab[]) => void;
  onRightPanelPatch: (tab: BrowserRightPanelPatch) => void;
  onDebugClick: (patch: unknown) => void;
  onDebugInput: (patch: unknown) => void;
  onDebugDrag: (patch: unknown) => void;
}

interface UseBrowserStateResult {
  state: BrowserState | null;
  setState: Dispatch<SetStateAction<BrowserState | null>>;
  refresh: () => Promise<void>;
  error: string | null;
  setError: Dispatch<SetStateAction<string | null>>;
  debugHighlights: DebugHighlightRequest[];
  setDebugHighlights: Dispatch<SetStateAction<DebugHighlightRequest[]>>;
}

function normalizeBrowserRightTabPatch(value: unknown): BrowserRightPanelPatch | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  if (key === "chat") return "chat";
  if (key === "requests" || key === "request center" || key === "vault requests") return "requests";
  if (key === "actions" || key === "action log" || key === "tasks") return "actions";
  if (key === "errors" || key === "console") return "errors";
  return null;
}

function transientPatchFromEvent(patch: unknown): Record<string, unknown> {
  if (!patch || typeof patch !== "object") return {};
  const p = patch as Record<string, unknown>;
  const transient: Record<string, unknown> = {};
  for (const key of ["rightTab", "debugClick", "debugInput", "debugDrag", "debugSurface", "debugHighlights", "clickSelector"]) {
    if (Object.prototype.hasOwnProperty.call(p, key)) transient[key] = p[key];
  }
  return transient;
}

export function useBrowserState({
  address,
  profileId,
  onPendingStartUrl,
  onMissingProfile,
  onLiveTabsChanged,
  onRightPanelPatch,
  onDebugClick,
  onDebugInput,
  onDebugDrag,
}: UseBrowserStateOptions): UseBrowserStateResult {
  const [state, setState] = useState<BrowserState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [debugHighlights, setDebugHighlights] = useState<DebugHighlightRequest[]>([]);

  const refresh = useCallback(async () => {
    const next = await browserApiGet<BrowserState>("/browser/state");
    setState(next);
    if (next.pendingStartUrl && !address) onPendingStartUrl(next.pendingStartUrl);
    if (next.profiles.some((profile) => profile.profileId === profileId) === false) {
      onMissingProfile(next.profiles);
    }
    onLiveTabsChanged(next.tabs ?? []);
  }, [address, onLiveTabsChanged, onMissingProfile, onPendingStartUrl, profileId]);

  useEffect(() => {
    void refresh().catch((err) => {
      if (inTauri()) setError(err instanceof Error ? err.message : String(err));
    });
    const id = window.setInterval(() => {
      void refresh().catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    if (!inTauri()) return;
    let socket: WebSocket | null = null;
    let closed = false;
    let retryTimer: number | null = null;
    const connectedAfterMs = Date.now() - 500;

    const applyPatch = (patch: unknown) => {
      if (!patch || typeof patch !== "object") return;
      const p = patch as Record<string, unknown>;
      const debugSurface = normalizeBrowserDebugSurface(p.debugSurface);
      if (debugSurface && debugSurface !== "browser") return;
      const rightTabPatch = normalizeBrowserRightTabPatch(p.rightTab);
      if (rightTabPatch) {
        onRightPanelPatch(rightTabPatch);
      }
      const debugClickPatch = p.debugClick ?? p.clickSelector;
      if (debugClickPatch) onDebugClick(debugClickPatch);
      const debugInputPatch = p.debugInput;
      if (debugInputPatch) onDebugInput(debugInputPatch);
      const debugDragPatch = p.debugDrag;
      if (debugDragPatch) onDebugDrag(debugDragPatch);
      const debugHighlightsPatch = normalizeBrowserDebugHighlights(p.debugHighlights);
      if (debugHighlightsPatch) {
        setDebugHighlights((prev) => (
          sameBrowserDebugHighlights(prev, debugHighlightsPatch) ? prev : debugHighlightsPatch
        ));
      }
    };

    const applyAuthoritativeUiPatch = (eventPatch: unknown) => {
      void browserApiGet<Record<string, unknown>>("/state/ui")
        .then((state) => {
          if (closed) return;
          applyPatch({ ...state, ...transientPatchFromEvent(eventPatch) });
        })
        .catch(() => {
          if (!closed) applyPatch(eventPatch);
        });
    };

    const connect = async () => {
      try {
        const [base, token] = await Promise.all([browserDebugApiBase(), getBrowserDebugToken()]);
        if (closed) return;
        const url = `${base.replace(/^http/, "ws")}/events?token=${encodeURIComponent(token)}`;
        socket = new WebSocket(url);
        socket.onmessage = (event) => {
          try {
            const frame = JSON.parse(String(event.data)) as { kind?: string; t?: number; payload?: { patch?: unknown } | null };
            if (frame.kind !== "debug-ui-state-patch") return;
            if (typeof frame.t === "number" && frame.t < connectedAfterMs) return;
            applyAuthoritativeUiPatch(frame.payload?.patch);
          } catch {
            /* ignore malformed debug stream frames */
          }
        };
        socket.onclose = () => {
          if (closed) return;
          retryTimer = window.setTimeout(() => void connect(), 2000);
        };
      } catch {
        if (!closed) retryTimer = window.setTimeout(() => void connect(), 4000);
      }
    };

    void connect();
    return () => {
      closed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, [onDebugClick, onDebugDrag, onDebugInput, onRightPanelPatch]);

  return {
    state,
    setState,
    refresh,
    error,
    setError,
    debugHighlights,
    setDebugHighlights,
  };
}
