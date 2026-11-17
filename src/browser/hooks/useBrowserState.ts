import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

import { createDebugUiCommandConsumer } from "../../lib/debug-ui-commands";
import { inTauri } from "../../lib/tauri-bridge";
import { parseRawEventFrame, type RawEventFrame } from "../../types/acp";
import { browserApiGet, browserApiPostJson, browserDebugApiBase, getBrowserDebugToken } from "../api";
import {
  createBrowserRefreshScheduler,
  type BrowserRefreshScope,
  waitForBrowserRefreshSlices,
} from "../browserRefreshScheduler";
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
  const publicManualState = (import.meta.env.SHELLX_PUBLIC_MANUAL_BUILD || import.meta.env.DEV)
    ? (globalThis as typeof globalThis & { __SHELLX_PUBLIC_MANUAL_BROWSER_STATE__?: BrowserState })
      .__SHELLX_PUBLIC_MANUAL_BROWSER_STATE__
    : undefined;
  const publicManualPreview = publicManualState !== undefined;
  const [state, setState] = useState<BrowserState | null>(() => publicManualState ?? null);
  const [error, setError] = useState<string | null>(null);
  const [debugHighlights, setDebugHighlights] = useState<DebugHighlightRequest[]>([]);
  if (import.meta.env.SHELLX_PUBLIC_MANUAL_BUILD || import.meta.env.DEV) {
    (globalThis as typeof globalThis & {
      __SHELLX_PUBLIC_MANUAL_SET_BROWSER_HIGHLIGHTS__?: Dispatch<SetStateAction<DebugHighlightRequest[]>>;
    }).__SHELLX_PUBLIC_MANUAL_SET_BROWSER_HIGHLIGHTS__ = setDebugHighlights;
  }
  const commandConsumerRef = useRef<ReturnType<typeof createDebugUiCommandConsumer> | null>(null);
  const refreshScopeRunnerRef = useRef<(scope: BrowserRefreshScope) => Promise<void>>(async () => undefined);
  const refreshSchedulerRef = useRef<ReturnType<typeof createBrowserRefreshScheduler> | null>(null);
  if (!refreshSchedulerRef.current) {
    refreshSchedulerRef.current = createBrowserRefreshScheduler((scope) => refreshScopeRunnerRef.current(scope));
  }
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

  const refreshScope = useCallback(async (scope: BrowserRefreshScope) => {
    await refreshCore();
    const slices: Array<Promise<void>> = [];
    if (scope.bookmarks) slices.push(refreshBookmarks());
    if (scope.requests) slices.push(refreshRequests());
    if (scope.transfers) slices.push(refreshTransfers());
    if (scope.history) slices.push(refreshHistory());
    if (scope.receipts) slices.push(refreshReceipts());
    if (scope.logs) slices.push(refreshLogs());
    await waitForBrowserRefreshSlices(slices);
  }, [refreshBookmarks, refreshCore, refreshHistory, refreshLogs, refreshReceipts, refreshRequests, refreshTransfers]);
  refreshScopeRunnerRef.current = refreshScope;

  const scheduleRefresh = useCallback((scope: BrowserRefreshScope) => refreshSchedulerRef.current!.refresh(scope), []);

  const refresh = useCallback(() => scheduleRefresh({
    bookmarks: true,
    requests: true,
    transfers: true,
    history: historyOpen,
    receipts: rightPanelTab === "actions",
    logs: rightPanelTab === "errors",
  }), [historyOpen, rightPanelTab, scheduleRefresh]);

  const refreshForBrowserEvent = useCallback((receiptKind: string) => scheduleRefresh({
    bookmarks: receiptKind.includes("Bookmark") || bookmarksOpen,
    requests: receiptKind.includes("SessionGrant") ||
      receiptKind.includes("VaultDeposit") ||
      receiptKind.includes("Dialog") ||
      receiptKind.includes("Permission") ||
      rightPanelTab === "requests",
    transfers: receiptKind.includes("Download") ||
      receiptKind.includes("Upload") ||
      receiptKind.includes("Transfer") ||
      transfersOpen,
    history: historyOpen,
    receipts: rightPanelTab === "actions",
    logs: rightPanelTab === "errors",
  }), [bookmarksOpen, historyOpen, rightPanelTab, scheduleRefresh, transfersOpen]);
  const refreshForBrowserEventRef = useRef(refreshForBrowserEvent);
  useEffect(() => {
    refreshForBrowserEventRef.current = refreshForBrowserEvent;
  }, [refreshForBrowserEvent]);

  useEffect(() => {
    if (publicManualPreview) return;
    void refresh().catch((err) => {
      if (inTauri()) setError(err instanceof Error ? err.message : String(err));
    });
    return undefined;
  }, [refresh]);

  useEffect(() => {
    if (publicManualPreview) return;
    // Native callbacks and timeout tasks can update the registry without a
    // Debug API broadcast. Keep compact reconciliation even with a live socket.
    let cancelled = false;
    let timer: number | null = null;
    const pollSummary = async () => {
      try {
        const summary = await browserApiGet<BrowserSummary>("/browser/summary");
        if (cancelled) return;
        const previous = lastSummaryRevisionRef.current;
        if (previous !== summary.revisions.state) {
          await refresh();
          if (!cancelled) lastSummaryRevisionRef.current = summary.revisions.state;
        }
      } catch {
        // Preserve the last reconciled revision so failed refreshes retry.
      }
      if (!cancelled) timer = window.setTimeout(() => void pollSummary(), transfersOpen ? 1_000 : 15_000);
    };
    void pollSummary();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [publicManualPreview, refresh, transfersOpen]);

  useEffect(() => {
    if (!inTauri()) return;
    let socket: WebSocket | null = null;
    let closed = false;
    let retryTimer: number | null = null;
    let browserRefreshTimer: number | null = null;
    let pendingBrowserReceiptKind = "browserEvent";
    let commandPollTimer: number | null = null;
    const commandCursorKey = "shellx.browserDebugUiCommandCursor.v1";
    if (!commandConsumerRef.current) {
      let saved: unknown = null;
      try { saved = JSON.parse(sessionStorage.getItem(commandCursorKey) ?? "null"); } catch { /* Memory cursor remains available. */ }
      commandConsumerRef.current = createDebugUiCommandConsumer(saved, "browser");
    }
    const commandConsumer = commandConsumerRef.current;

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

    let commandReadActive = false;
    let commandReadRequested = false;
    const requestUiCommands = async () => {
      commandReadRequested = true;
      if (commandReadActive || closed) return;
      commandReadActive = true;
      try {
        while (commandReadRequested && !closed) {
          commandReadRequested = false;
          const state = await browserApiGet<Record<string, unknown>>("/state/ui");
          if (closed) return;
          onCoworkUiStateRef.current?.(state);
          commandConsumer.consume(state, applyPatch, (cursor) => {
            try { sessionStorage.setItem(commandCursorKey, JSON.stringify(cursor)); } catch { /* Keep the memory cursor. */ }
          }, (missing) => {
            void browserApiPostJson("/state/ui", {
              source: "renderer-browser-ui-command-gap", debugSurface: "browser",
              debugActionResults: [{ action: "uiCommandDelivery", status: "failed",
                message: `UI commands ${missing.from}–${missing.to} expired before delivery. Reissue the intended commands.` }],
            }).catch(() => undefined);
          });
        }
      } catch {
        /* Retry exact snapshot commands; redacted event payloads are not executable. */
      } finally {
        commandReadActive = false;
      }
    };
    const pollUiCommands = async () => {
      await requestUiCommands();
      if (!closed) commandPollTimer = window.setTimeout(() => void pollUiCommands(), 1000);
    };

    const connect = async () => {
      try {
        const [base, token] = await Promise.all([browserDebugApiBase(), getBrowserDebugToken()]);
        if (closed) return;
        const url = `${base.replace(/^http/, "ws")}/events?token=${encodeURIComponent(token)}`;
        socket = new WebSocket(url);
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
              void requestUiCommands();
              return;
            }
            if (frame.kind !== "browser-event") return;
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
          retryTimer = window.setTimeout(() => void connect(), 2000);
        };
      } catch {
        if (!closed) retryTimer = window.setTimeout(() => void connect(), 4000);
      }
    };

    void connect();
    void pollUiCommands();
    return () => {
      closed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (browserRefreshTimer !== null) window.clearTimeout(browserRefreshTimer);
      if (commandPollTimer !== null) window.clearTimeout(commandPollTimer);
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
