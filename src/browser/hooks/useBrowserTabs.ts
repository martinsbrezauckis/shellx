import { useCallback, useState, type Dispatch, type MouseEvent, type SetStateAction } from "react";

import {
  browserApiPostJson,
  delegateBrowserTabToAgent,
  takeBackBrowserTabFromAgent,
} from "../api";
import type { BrowserProfile, BrowserTab, BrowserTask } from "../types";
import { DEFAULT_HOME_URL } from "../browserPreferences";
import { isTrustedShellxUserEvent, type ShellxUserEventLike } from "../../lib/trusted-user-event";

const UI_BROWSER_AGENT_ID = "shellx-browser-ui";
const UI_BROWSER_RUN_ID = "browser-window";

export interface BrowserTabLease {
  leaseId: string;
  ownerAgentId: string;
  ownerRunId: string;
}

export type BrowserTabHandoffStatus =
  | { tone: "review" | "pending" }
  | { tone: "error" | "success"; message: string };

export interface BrowserTabHandoffConfirmation {
  browserTabId: string;
  currentOrigin: string;
  currentUrlContext: string;
  ownerLabel: string;
  persistenceLabel: string;
  profileId: string;
  profileLabel: string;
  reviewFingerprint: string;
  taskId: string;
  taskLabel: string;
}

type BrowserTabHandoffReviewContext = Omit<BrowserTabHandoffConfirmation, "reviewFingerprint">;

const BROWSER_TAB_HANDOFF_REVIEW_SCHEMA = "shellx.browser-tab-handoff-review.v1";

/** Keeps a handoff review useful without rendering credentials, query values, fragments, or local paths. */
export function browserTabHandoffUrlContext(url?: string | null): Pick<BrowserTabHandoffConfirmation, "currentOrigin" | "currentUrlContext"> {
  const candidate = url?.trim();
  if (!candidate) {
    return {
      currentOrigin: "Origin unavailable",
      currentUrlContext: "No current page context is available",
    };
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        currentOrigin: `${parsed.protocol.replace(/:$/, "")} context`,
        currentUrlContext: "Local or non-web URL context is withheld",
      };
    }
    const pathname = parsed.pathname || "/";
    const boundedPathname = pathname.length > 160 ? `${pathname.slice(0, 159)}…` : pathname;
    return {
      currentOrigin: parsed.origin,
      currentUrlContext: `${parsed.origin}${boundedPathname}`,
    };
  } catch {
    return {
      currentOrigin: "Origin unavailable",
      currentUrlContext: "Current URL context is unavailable",
    };
  }
}

function handoffOwnerLabel(ownerKind?: BrowserTab["ownerKind"]): string {
  if (ownerKind === "delegatedToAgent") return "Delegated to agent";
  if (ownerKind === "agent") return "Agent-controlled";
  return "User-controlled";
}

function handoffPersistenceLabel(tab: BrowserTab, profile: BrowserProfile | null): string {
  if (profile) return profile.persistent ? "Persistent profile storage" : "Disposable task storage";
  if (tab.storageRoot) return "Persistent Browser storage";
  return tab.profileId === "task-disposable" ? "Disposable task storage" : "Profile persistence is unavailable";
}

function browserTabHandoffReviewContext(
  tab: BrowserTab,
  task: BrowserTask,
  profile: BrowserProfile | null,
): BrowserTabHandoffReviewContext {
  return {
    browserTabId: tab.browserTabId,
    ...browserTabHandoffUrlContext(tab.url),
    ownerLabel: handoffOwnerLabel(tab.ownerKind),
    persistenceLabel: handoffPersistenceLabel(tab, profile),
    profileId: tab.profileId,
    profileLabel: profile?.label || tab.profileId,
    taskId: task.taskId,
    taskLabel: task.goal || "Untitled Browser task",
  };
}

/** Hashes the exact reviewed state without exposing raw page or storage data to the UI or receipt. */
export async function browserTabHandoffReviewFingerprint(
  tab: BrowserTab,
  task: BrowserTask,
  profile: BrowserProfile,
): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Secure Browser handoff review is unavailable in this runtime.");
  const canonical = JSON.stringify([
    BROWSER_TAB_HANDOFF_REVIEW_SCHEMA,
    tab.browserTabId,
    tab.engineId,
    tab.taskId ?? null,
    tab.profileId,
    tab.url ?? null,
    tab.storageRoot ?? null,
    tab.ownerKind ?? "user",
    tab.delegatedTaskId ?? null,
    tab.delegatedGrantId ?? null,
    tab.lock?.leaseId ?? null,
    tab.lock?.ownerAgentId ?? null,
    tab.lock?.ownerRunId ?? null,
    tab.lock?.scope ?? null,
    tab.updatedAtMs,
    profile.profileId,
    profile.label,
    profile.description,
    profile.agentDefault,
    profile.cookiesEnabled,
    profile.persistent,
    profile.storageRoot ?? null,
    task.taskId,
    task.profileId,
    task.ownerActorId,
    task.ownerSurface,
    task.ownerSessionId ?? null,
    task.goal,
    task.status,
  ]);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function browserTabHandoffConfirmation(
  tab: BrowserTab,
  task: BrowserTask,
  profile: BrowserProfile,
): Promise<BrowserTabHandoffConfirmation> {
  return {
    ...browserTabHandoffReviewContext(tab, task, profile),
    reviewFingerprint: await browserTabHandoffReviewFingerprint(tab, task, profile),
  };
}

export function browserTabHandoffRevalidationError(
  confirmation: BrowserTabHandoffConfirmation,
  activeBrowserTab: BrowserTab | null,
  activeTask: BrowserTask | null,
  tabs: BrowserTab[],
  profiles: BrowserProfile[],
): string | null {
  const liveTab = tabs.find((tab) => tab.browserTabId === confirmation.browserTabId);
  if (!liveTab) return "This tab is no longer open. Review the current Browser state before handing it off.";
  if (activeBrowserTab?.browserTabId !== confirmation.browserTabId) {
    return "The active Browser tab changed. Review the current tab before handing it off.";
  }
  if (activeTask?.taskId !== confirmation.taskId) {
    return "The active Browser task changed. Review the current task before handing it off.";
  }
  if ((activeTask.goal || "Untitled Browser task") !== confirmation.taskLabel) {
    return "The target Browser task label changed. Review the current task before handing it off.";
  }
  if (liveTab.ownerKind === "agent" || liveTab.ownerKind === "delegatedToAgent") {
    return "This tab is no longer user-controlled and cannot be handed off again.";
  }
  const liveConfirmation = browserTabHandoffReviewContext(
    liveTab,
    activeTask,
    profiles.find((profile) => profile.profileId === liveTab.profileId) ?? null,
  );
  if (
    liveConfirmation.currentOrigin !== confirmation.currentOrigin ||
    liveConfirmation.currentUrlContext !== confirmation.currentUrlContext ||
    liveConfirmation.profileId !== confirmation.profileId ||
    liveConfirmation.profileLabel !== confirmation.profileLabel ||
    liveConfirmation.persistenceLabel !== confirmation.persistenceLabel ||
    liveConfirmation.ownerLabel !== confirmation.ownerLabel
  ) {
    return "The tab context, profile, persistence, or owner changed. Review the current tab before handing it off.";
  }
  return null;
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
  profiles: BrowserProfile[];
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
    profiles,
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
  const [handoffConfirmation, setHandoffConfirmation] = useState<BrowserTabHandoffConfirmation | null>(null);
  const [handoffStatus, setHandoffStatus] = useState<BrowserTabHandoffStatus>({ tone: "review" });
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
    const profile = profiles.find((candidate) => candidate.profileId === activeBrowserTab.profileId);
    if (!profile) {
      setError("The active Browser profile is unavailable. Refresh Browser state before handing off this tab.");
      return;
    }
    void runBusy(async () => {
      const confirmation = await browserTabHandoffConfirmation(activeBrowserTab, activeTask, profile);
      setHandoffConfirmation(confirmation);
      setHandoffStatus({ tone: "review" });
    });
  };

  const cancelHandOffActiveTab = () => {
    if (handoffStatus.tone === "pending") return;
    setHandoffConfirmation(null);
    setHandoffStatus({ tone: "review" });
  };

  const confirmHandOffActiveTab = (event?: ShellxUserEventLike | null) => {
    if (!isTrustedShellxUserEvent(event)) {
      setHandoffStatus({ tone: "error", message: "Browser tab handoff requires a direct confirmation click." });
      return;
    }
    if (!handoffConfirmation || handoffStatus.tone === "pending") return;
    const revalidationError = browserTabHandoffRevalidationError(
      handoffConfirmation,
      activeBrowserTab,
      activeTask,
      tabs,
      profiles,
    );
    if (revalidationError) {
      setHandoffStatus({ tone: "error", message: revalidationError });
      return;
    }
    setHandoffStatus({ tone: "pending" });
    void runBusy(async () => {
      try {
        await delegateBrowserTabToAgent({
          browserTabId: handoffConfirmation.browserTabId,
          taskId: handoffConfirmation.taskId,
          reviewFingerprint: handoffConfirmation.reviewFingerprint,
          reason: "operator handoff from Browser chrome",
        });
        setHandoffStatus({ tone: "success", message: "Tab handed off to the active Browser agent task." });
      } catch (error) {
        setHandoffStatus({
          tone: "error",
          message: error instanceof Error ? error.message : "Browser tab handoff could not be completed.",
        });
        throw error;
      }
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
    cancelHandOffActiveTab,
    closeTab,
    confirmHandOffActiveTab,
    draggedTabId,
    focusTab,
    handOffActiveTab,
    handoffConfirmation,
    handoffStatus,
    newTab,
    reorderTabs,
    setDraggedTabId,
    takeBackActiveTab,
    toggleLockActiveTab,
  };
}

export function selectBrowserHandoffTask(
  activeTask: BrowserTask | null,
  tasks: BrowserTask[],
): BrowserTask | null {
  if (activeTask && !["completed", "blocked", "aborted"].includes(activeTask.status)) return activeTask;
  const available = tasks.filter((task) => !["completed", "blocked", "aborted"].includes(task.status));
  return available.length === 1 ? available[0]! : null;
}
