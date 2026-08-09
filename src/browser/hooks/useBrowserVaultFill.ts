import { useEffect, useMemo, useRef, useState } from "react";

import {
  browserApiPostJson,
  fillUserVaultSecret,
  listBrowserVaultKeys,
  normalizeBrowserVaultFillActionResponse,
  type BrowserVaultKeyMeta,
} from "../api";
import type { BrowserTab } from "../types";
import {
  browserVaultFillFieldKind,
  buildBrowserVaultFillCandidates,
  normalizeBrowserObservation,
  type BrowserObservationLike,
  type BrowserVaultFillCandidate,
} from "../vaultFillCandidates";
import { inTauri } from "../../lib/tauri-bridge";
import { isTrustedShellxUserEvent, type ShellxUserEventLike } from "../../lib/trusted-user-event";

interface BrowserVaultFillOptions {
  activeBrowserTab: BrowserTab | null;
  addressEditing: boolean;
  engineLoadStatus: string | null;
  engineUrl: string | null;
  headerMenuOpen: boolean;
  manualFillAllowed: boolean;
  optionsOpen: boolean;
  pageUrl: string;
  personalTabLocked: boolean;
  vaultDepositCount: number;
  onCloseMenu: () => void;
  onOpenMenu: () => void;
  runBusy: (action: () => Promise<void>) => Promise<void>;
  setError: (message: string | null) => void;
}

export function useBrowserVaultFill(options: BrowserVaultFillOptions) {
  const {
    activeBrowserTab,
    addressEditing,
    engineLoadStatus,
    engineUrl,
    headerMenuOpen,
    manualFillAllowed,
    optionsOpen,
    pageUrl,
    personalTabLocked,
    vaultDepositCount,
    onCloseMenu,
    onOpenMenu,
    runBusy,
    setError,
  } = options;
  const lastOfferRef = useRef<string | null>(null);
  const [entries, setEntries] = useState<BrowserVaultKeyMeta[]>([]);
  const [error, setVaultError] = useState<string | null>(null);
  const [observation, setObservation] = useState<BrowserObservationLike | null>(null);
  const [observationRefresh, setObservationRefresh] = useState(0);

  const candidates = useMemo(
    () => manualFillAllowed
      ? buildBrowserVaultFillCandidates({ entries, observation, url: pageUrl })
      : [],
    [entries, manualFillAllowed, observation, pageUrl],
  );
  const detectedFieldCount = useMemo(
    () => (observation?.refs ?? []).filter((ref) => Boolean(browserVaultFillFieldKind(ref))).length,
    [observation],
  );

  useEffect(() => {
    if (!inTauri()) return;
    let cancelled = false;
    const refreshVaultFillEntries = () => {
      void listBrowserVaultKeys()
        .then((nextEntries) => {
          if (cancelled) return;
          setEntries(nextEntries);
          setVaultError(null);
        })
        .catch((err) => {
          if (cancelled) return;
          setEntries([]);
          const message = err instanceof Error ? err.message : String(err);
          setVaultError(message || "Vault is locked or unavailable.");
        });
    };
    refreshVaultFillEntries();
    const timer = window.setInterval(refreshVaultFillEntries, 8_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeBrowserTab?.browserTabId, activeBrowserTab?.url, engineUrl, manualFillAllowed, observationRefresh, vaultDepositCount]);

  useEffect(() => {
    let cancelled = false;
    setObservation(null);
    if (!activeBrowserTab || personalTabLocked || !manualFillAllowed) return () => {
      cancelled = true;
    };
    const rawUrl = engineUrl ?? activeBrowserTab.url ?? "";
    if (!rawUrl.trim() || rawUrl.startsWith("about:")) return () => {
      cancelled = true;
    };
    const timer = window.setTimeout(() => {
      void browserApiPostJson<unknown>("/browser/action", {
        browserTabId: activeBrowserTab.browserTabId,
        action: "observe",
      })
        .then(normalizeBrowserVaultFillActionResponse)
        .then((response) => {
          if (!cancelled) setObservation(normalizeBrowserObservation(response.observation));
        })
        .catch(() => {
          if (!cancelled) setObservation(null);
        });
    }, 450);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeBrowserTab?.browserTabId, activeBrowserTab?.url, engineLoadStatus, engineUrl, manualFillAllowed, observationRefresh, personalTabLocked]);

  useEffect(() => {
    const hasFillSurface = candidates.length > 0 || (Boolean(error) && detectedFieldCount > 0);
    if (!hasFillSurface || personalTabLocked || optionsOpen || addressEditing || headerMenuOpen) return;
    const signature = [
      activeBrowserTab?.browserTabId ?? "no-tab",
      pageUrl,
      error ?? "",
      candidates.map((candidate) => candidate.id).join("|"),
    ].join("::");
    if (lastOfferRef.current === signature) return;
    lastOfferRef.current = signature;
    onOpenMenu();
  }, [activeBrowserTab?.browserTabId, addressEditing, candidates, detectedFieldCount, error, headerMenuOpen, onOpenMenu, optionsOpen, pageUrl, personalTabLocked]);

  const fillCandidate = (candidate: BrowserVaultFillCandidate, event: ShellxUserEventLike) => {
    if (!isTrustedShellxUserEvent(event)) {
      setError("Vault fill requires a direct user click.");
      return;
    }
    if (!activeBrowserTab) return;
    void runBusy(async () => {
      const response = await fillUserVaultSecret({
        browserTabId: activeBrowserTab.browserTabId,
        secretRef: candidate.key,
        refId: candidate.refId,
        selector: candidate.selector,
        expectedOrigin: candidate.origin,
      });
      if (response.ok === false || response.status === "blocked") {
        throw new Error(response.message || "Vault fill was blocked.");
      }
      onCloseMenu();
      setObservation(null);
      setObservationRefresh((current) => current + 1);
    });
  };

  return {
    candidates,
    detectedFieldCount,
    error,
    fillCandidate,
    requestObservationRefresh: () => setObservationRefresh((current) => current + 1),
  };
}
