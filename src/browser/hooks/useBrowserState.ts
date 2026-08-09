import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

import { inTauri } from "../../lib/tauri-bridge";
import { parseRawEventFrame, type RawEventFrame } from "../../types/acp";
import { browserApiGet, browserDebugApiBase, getBrowserDebugToken } from "../api";
import {
  normalizeBrowserDebugHighlights,
  normalizeBrowserDebugSurface,
  sameBrowserDebugHighlights,
} from "../debugBridge";
import type {
  BrowserBookmark,
  BrowserBookmarkToolbarItem,
  BrowserConsoleLog,
  BrowserHistoryEntry,
  BrowserProfile,
  BrowserReceipt,
  BrowserSessionGrant,
  BrowserState,
  BrowserSummary,
  BrowserTab,
  BrowserTransferEntry,
  BrowserVaultDeposit,
} from "../types";
import type { DebugHighlightRequest } from "../../components/DebugHighlightOverlay";

export type BrowserRightPanelPatch = "chat" | "requests" | "actions" | "evidence" | "errors";

interface UseBrowserStateOptions {
  address: string;
  profileId: string;
  rightPanelTab: BrowserRightPanelPatch;
  historyOpen: boolean;
  bookmarksOpen: boolean;
  transfersOpen: boolean;
  onPendingStartUrl: (url: string) => void;
  onMissingProfile: (profiles: BrowserProfile[]) => void;
  onLiveTabsChanged: (tabs: BrowserTab[]) => void;
  onRightPanelPatch: (tab: BrowserRightPanelPatch) => void;
  onDebugClick: (patch: unknown) => void;
  onDebugInput: (patch: unknown) => void;
  onDebugDrag: (patch: unknown) => void;
  onSessionEvent?: (frame: RawEventFrame) => void;
  onCoworkUiState?: (state: unknown) => void;
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
  if (key === "evidence" || key === "flight recorder") return "evidence";
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
  rightPanelTab,
  historyOpen,
  bookmarksOpen,
  transfersOpen,
  onPendingStartUrl,
  onMissingProfile,
  onLiveTabsChanged,
  onRightPanelPatch,
  onDebugClick,
  onDebugInput,
  onDebugDrag,
  onSessionEvent,
  onCoworkUiState,
}: UseBrowserStateOptions): UseBrowserStateResult {
  const [state, setState] = useState<BrowserState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [debugHighlights, setDebugHighlights] = useState<DebugHighlightRequest[]>([]);
  const [eventConnected, setEventConnected] = useState(false);
  const lastSummaryRevisionRef = useRef<string | null>(null);
  const onSessionEventRef = useRef(onSessionEvent);
  const onCoworkUiStateRef = useRef(onCoworkUiState);
  useEffect(() => {
    onSessionEventRef.current = onSessionEvent;
  }, [onSessionEvent]);
  useEffect(() => {
    onCoworkUiStateRef.current = onCoworkUiState;
  }, [onCoworkUiState]);

  const mergeStatePatch = useCallback((patch: Partial<BrowserState>) => {
    setState((current) => current ? { ...current, ...patch } : current);
  }, []);

  const refreshCore = useCallback(async () => {
    const next = await browserApiGet<BrowserState>("/browser/state?view=core");
    setState((current) => ({
      ...next,
      bookmarks: current?.bookmarks ?? [],
      bookmarkToolbar: current?.bookmarkToolbar ?? [],
      history: current?.history ?? [],
      sessionGrants: current?.sessionGrants ?? [],
      vaultDeposits: current?.vaultDeposits ?? [],
      downloads: current?.downloads ?? [],
      uploads: current?.uploads ?? [],
      consoleLogs: current?.consoleLogs ?? [],
      receipts: current?.receipts ?? [],
    }));
    if (next.pendingStartUrl && !address) onPendingStartUrl(next.pendingStartUrl);
    if (next.profiles.some((profile) => profile.profileId === profileId) === false) {
      onMissingProfile(next.profiles);
    }
    onLiveTabsChanged(next.tabs ?? []);
  }, [address, onLiveTabsChanged, onMissingProfile, onPendingStartUrl, profileId]);

  const refreshBookmarks = useCallback(async () => {
    const next = await browserApiGet<{ bookmarks: BrowserBookmark[]; bookmarkToolbar: BrowserBookmarkToolbarItem[] }>("/browser/bookmarks");
    mergeStatePatch(next);
  }, [mergeStatePatch]);

  const refreshRequests = useCallback(async () => {
    const next = await browserApiGet<{ sessionGrants: BrowserSessionGrant[]; vaultDeposits: BrowserVaultDeposit[] }>("/browser/requests");
    mergeStatePatch({ sessionGrants: next.sessionGrants, vaultDeposits: next.vaultDeposits });
  }, [mergeStatePatch]);

  const refreshTransfers = useCallback(async () => {
    const [downloads, uploads] = await Promise.all([
      browserApiGet<{ downloads: BrowserTransferEntry[] }>("/browser/downloads"),
      browserApiGet<{ uploads: BrowserTransferEntry[] }>("/browser/uploads"),
    ]);
    mergeStatePatch({ downloads: downloads.downloads, uploads: uploads.uploads });
  }, [mergeStatePatch]);

  const refreshHistory = useCallback(async () => {
    const next = await browserApiGet<{ history: BrowserHistoryEntry[] }>("/browser/history?limit=1000");
    mergeStatePatch({ history: next.history });
  }, [mergeStatePatch]);

  const refreshReceipts = useCallback(async () => {
    const next = await browserApiGet<{ receipts: BrowserReceipt[] }>("/browser/receipts?limit=200");
    mergeStatePatch({ receipts: next.receipts });
  }, [mergeStatePatch]);

  const refreshLogs = useCallback(async () => {
    const next = await browserApiGet<{ logs: BrowserConsoleLog[] }>("/browser/logs?limit=200");
    mergeStatePatch({ consoleLogs: next.logs });
  }, [mergeStatePatch]);

  const refresh = useCallback(async () => {
    await refreshCore();
    const slices: Array<Promise<void>> = [refreshBookmarks(), refreshRequests(), refreshTransfers()];
    if (historyOpen) slices.push(refreshHistory());
    if (rightPanelTab === "actions") slices.push(refreshReceipts());
    if (rightPanelTab === "errors") slices.push(refreshLogs());
    await Promise.all(slices);
  }, [historyOpen, refreshBookmarks, refreshCore, refreshHistory, refreshLogs, refreshReceipts, refreshRequests, refreshTransfers, rightPanelTab]);

  const refreshForBrowserEvent = useCallback(async (receiptKind: string) => {
    await refreshCore();
    const slices: Array<Promise<void>> = [];
    if (receiptKind.includes("Bookmark") || bookmarksOpen) slices.push(refreshBookmarks());
    if (
      receiptKind.includes("SessionGrant") ||
      receiptKind.includes("VaultDeposit") ||
      receiptKind.includes("Dialog") ||
      receiptKind.includes("Permission") ||
      rightPanelTab === "requests"
    ) {
      slices.push(refreshRequests());
    }
    if (
      receiptKind.includes("Download") ||
      receiptKind.includes("Upload") ||
      receiptKind.includes("Transfer") ||
      transfersOpen
    ) {
      slices.push(refreshTransfers());
    }
    if (historyOpen) slices.push(refreshHistory());
    if (rightPanelTab === "actions") slices.push(refreshReceipts());
    if (rightPanelTab === "errors") slices.push(refreshLogs());
    await Promise.all(slices);
  }, [bookmarksOpen, historyOpen, refreshBookmarks, refreshCore, refreshHistory, refreshLogs, refreshReceipts, refreshRequests, refreshTransfers, rightPanelTab, transfersOpen]);
  const refreshForBrowserEventRef = useRef(refreshForBrowserEvent);
  useEffect(() => {
    refreshForBrowserEventRef.current = refreshForBrowserEvent;
  }, [refreshForBrowserEvent]);

  useEffect(() => {
    void refresh().catch((err) => {
      if (inTauri()) setError(err instanceof Error ? err.message : String(err));
    });
    return undefined;
  }, [refresh]);

  useEffect(() => {
    if (eventConnected) return;
    let cancelled = false;
    let timer: number | null = null;
    const pollSummary = async () => {
      try {
        const summary = await browserApiGet<BrowserSummary>("/browser/summary");
        const previous = lastSummaryRevisionRef.current;
        lastSummaryRevisionRef.current = summary.revisions.state;
        if (previous !== null && previous !== summary.revisions.state) {
          await refresh();
        }
      } catch {
        // A disconnected Browser renderer keeps retrying the compact summary only.
      }
      if (!cancelled) timer = window.setTimeout(() => void pollSummary(), 15_000);
    };
    void pollSummary();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [eventConnected, refresh]);

  useEffect(() => {
    if (!inTauri()) return;
    let socket: WebSocket | null = null;
    let closed = false;
    let retryTimer: number | null = null;
    let browserRefreshTimer: number | null = null;
    let pendingBrowserReceiptKind = "browserEvent";
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
          onCoworkUiStateRef.current?.(state);
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
        socket.onopen = () => {
          if (!closed) setEventConnected(true);
        };
        socket.onmessage = (event) => {
          try {
            const frame = parseRawEventFrame(JSON.parse(String(event.data)));
            if (!frame) return;
            if (frame.kind === "grok-acp-event" || frame.kind === "provider-session-event") {
              onSessionEventRef.current?.(frame);
              return;
            }
            const payload = frame.payload as {
              patch?: unknown;
              revision?: string | number;
              receipt?: { kind?: string; t?: number };
            } | null;
            if (frame.kind === "debug-ui-state-patch") {
              if (typeof frame.t === "number" && frame.t < connectedAfterMs) return;
              applyAuthoritativeUiPatch(payload?.patch);
              return;
            }
            if (frame.kind !== "browser-event") return;
            const revision = payload?.revision ?? payload?.receipt?.t ?? frame.t;
            if (typeof revision === "string" || typeof revision === "number") {
              lastSummaryRevisionRef.current = String(revision).startsWith("state-")
                ? String(revision)
                : `state-${revision}`;
            }
            pendingBrowserReceiptKind = payload?.receipt?.kind ?? "browserEvent";
            if (browserRefreshTimer !== null) window.clearTimeout(browserRefreshTimer);
            browserRefreshTimer = window.setTimeout(() => {
              browserRefreshTimer = null;
              void refreshForBrowserEventRef.current(pendingBrowserReceiptKind).catch(() => undefined);
            }, 50);
          } catch {
            /* ignore malformed debug stream frames */
          }
        };
        socket.onclose = () => {
          if (closed) return;
          setEventConnected(false);
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
      if (browserRefreshTimer !== null) window.clearTimeout(browserRefreshTimer);
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
