import { useCallback, useState, type Dispatch, type MouseEvent, type SetStateAction } from "react";

import {
  browserApiPostJson,
  delegateBrowserTabToAgent,
  takeBackBrowserTabFromAgent,
} from "../api";
import type { BrowserTab, BrowserTask } from "../types";
import { DEFAULT_HOME_URL } from "../browserPreferences";
import { isTrustedShellxUserEvent, type ShellxUserEventLike } from "../../lib/trusted-user-event";

const UI_BROWSER_AGENT_ID = "shellx-browser-ui";
const UI_BROWSER_RUN_ID = "browser-window";

export interface BrowserTabLease {
  leaseId: string;
  ownerAgentId: string;
  ownerRunId: string;
}

export function useBrowserTabLeases() {
  const [leases, setLeases] = useState<Record<string, BrowserTabLease>>({});
  const handleLiveTabsChanged = useCallback((liveTabs: BrowserTab[]) => {
    setLeases((current) => {
      const live = new Set(liveTabs.map((tab) => tab.browserTabId));
      return Object.fromEntries(Object.entries(current).filter(([tabId]) => live.has(tabId)));
    });
  }, []);
  return { handleLiveTabsChanged, leases, setLeases };
}

interface BrowserTabsOptions {
  activeBrowserTab: BrowserTab | null;
  activeTask: BrowserTask | null;
  homeUrl: string;
  leases: Record<string, BrowserTabLease>;
  personalBrowserLocked: boolean;
  runBusy: (action: () => Promise<void>) => Promise<void>;
  setAddress: (value: string) => void;
  setError: (message: string | null) => void;
  setLeases: Dispatch<SetStateAction<Record<string, BrowserTabLease>>>;
  setProfileId: (value: string) => void;
  showPersonalLockBlockedNotice: () => void;
  tabs: BrowserTab[];
  userDefaultProfileId: string;
}

export function useBrowserTabs(options: BrowserTabsOptions) {
  const {
    activeBrowserTab,
    activeTask,
    homeUrl,
    leases,
    personalBrowserLocked,
    runBusy,
    setAddress,
    setError,
    setLeases,
    setProfileId,
    showPersonalLockBlockedNotice,
    tabs,
    userDefaultProfileId,
  } = options;
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const activeLease = activeBrowserTab ? leases[activeBrowserTab.browserTabId] ?? null : null;
  const canHandOffActiveTab = Boolean(
    activeBrowserTab &&
    activeTask &&
    activeBrowserTab.ownerKind !== "delegatedToAgent" &&
    activeBrowserTab.ownerKind !== "agent"
  );
  const canTakeBackActiveTab = activeBrowserTab?.ownerKind === "delegatedToAgent";

  const actionContext = () => ({
    ...(activeBrowserTab ? { browserTabId: activeBrowserTab.browserTabId } : {}),
    ...(activeLease
      ? {
          lockLeaseId: activeLease.leaseId,
          ownerAgentId: activeLease.ownerAgentId,
          ownerRunId: activeLease.ownerRunId,
        }
      : {}),
  });

  const reorderTabs = (sourceTabId: string | null, targetTabId: string) => {
    if (!sourceTabId || sourceTabId === targetTabId) return;
    const currentIds = tabs.map((tab) => tab.browserTabId);
    const from = currentIds.indexOf(sourceTabId);
    const to = currentIds.indexOf(targetTabId);
    if (from < 0 || to < 0) return;
    const nextIds = currentIds.slice();
    const [moved] = nextIds.splice(from, 1);
    if (!moved) return;
    nextIds.splice(to, 0, moved);
    void runBusy(async () => {
      await browserApiPostJson("/browser/tabs/reorder", { browserTabIds: nextIds });
      setDraggedTabId(null);
    });
  };

  const newTab = (nextProfileId = userDefaultProfileId) => {
    if (nextProfileId === userDefaultProfileId && personalBrowserLocked) {
      showPersonalLockBlockedNotice();
      return;
    }
    void runBusy(async () => {
      const newTabUrl = homeUrl.trim() || DEFAULT_HOME_URL;
      await browserApiPostJson("/browser/tabs/open", {
        profileId: nextProfileId,
        url: newTabUrl,
      });
      setProfileId(nextProfileId);
      setAddress(newTabUrl);
    });
  };

  const focusTab = (tab: BrowserTab) => {
    void runBusy(async () => {
      const lease = leases[tab.browserTabId];
      await browserApiPostJson("/browser/tabs/focus", {
        browserTabId: tab.browserTabId,
        ...(lease
          ? {
              lockLeaseId: lease.leaseId,
              ownerAgentId: lease.ownerAgentId,
              ownerRunId: lease.ownerRunId,
            }
          : {}),
      });
      setProfileId(tab.profileId);
      if (tab.url) setAddress(tab.url);
    });
  };

  const closeTab = (tab: BrowserTab, event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    void runBusy(async () => {
      const lease = leases[tab.browserTabId];
      const response = await browserApiPostJson<{ ok: boolean; error?: string }>("/browser/tabs/close", {
        browserTabId: tab.browserTabId,
        ...(lease
          ? {
              lockLeaseId: lease.leaseId,
              ownerAgentId: lease.ownerAgentId,
              ownerRunId: lease.ownerRunId,
            }
          : {}),
      });
      if (!response.ok) throw new Error(response.error || "Browser tab could not be closed because it is locked.");
      setLeases((current) => {
        const next = { ...current };
        delete next[tab.browserTabId];
        return next;
      });
    });
  };

  const toggleLockActiveTab = () => {
    if (!activeBrowserTab) return;
    void runBusy(async () => {
      const lease = leases[activeBrowserTab.browserTabId];
      if (activeBrowserTab.lock && lease) {
        await browserApiPostJson("/browser/tabs/unlock", {
          browserTabId: activeBrowserTab.browserTabId,
          leaseId: lease.leaseId,
          ownerAgentId: lease.ownerAgentId,
          ownerRunId: lease.ownerRunId,
        });
        setLeases((current) => {
          const next = { ...current };
          delete next[activeBrowserTab.browserTabId];
          return next;
        });
        return;
      }
      const response = await browserApiPostJson<{ tab?: BrowserTab }>("/browser/tabs/lock", {
        browserTabId: activeBrowserTab.browserTabId,
        ownerAgentId: UI_BROWSER_AGENT_ID,
        ownerRunId: UI_BROWSER_RUN_ID,
        ttlSeconds: 900,
      });
      const lock = response.tab?.lock;
      if (lock) {
        setLeases((current) => ({
          ...current,
          [activeBrowserTab.browserTabId]: {
            leaseId: lock.leaseId,
            ownerAgentId: lock.ownerAgentId,
            ownerRunId: lock.ownerRunId,
          },
        }));
      }
    });
  };

  const handOffActiveTab = (event?: ShellxUserEventLike | null) => {
    if (!isTrustedShellxUserEvent(event)) {
      setError("Browser tab handoff requires a direct user click.");
      return;
    }
    if (!activeBrowserTab || !activeTask) {
      setError("Start an agent browser task before handing off a user tab.");
      return;
    }
    if (!window.confirm("Hand this tab to the active Browser agent task? Vault secrets will still require separate approval.")) return;
    void runBusy(async () => {
      await delegateBrowserTabToAgent({
        browserTabId: activeBrowserTab.browserTabId,
        taskId: activeTask.taskId,
        reason: "operator handoff from Browser chrome",
      });
    });
  };

  const takeBackActiveTab = () => {
    if (!activeBrowserTab) return;
    void runBusy(async () => {
      await takeBackBrowserTabFromAgent({
        browserTabId: activeBrowserTab.browserTabId,
        reason: "operator takeback from Browser chrome",
      });
    });
  };

  return {
    actionContext,
    canHandOffActiveTab,
    canTakeBackActiveTab,
    closeTab,
    draggedTabId,
    focusTab,
    handOffActiveTab,
    newTab,
    reorderTabs,
    setDraggedTabId,
    takeBackActiveTab,
    toggleLockActiveTab,
  };
}
