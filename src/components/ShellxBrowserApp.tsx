import { lazy, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type JSX } from "react";

import { inTauri } from "../lib/tauri-bridge";
import {
  browserApiPostJson,
  openBrowserVaultPanel,
  removeBrowserSiteShields,
  resolveBrowserSessionGrant,
  updateBrowserPrivacy,
  updateBrowserShields,
  updateBrowserSiteShields,
} from "../browser/api";
import { AgentSidebar } from "../browser/components/AgentSidebar";
import { BookmarkToolbar } from "../browser/components/BookmarkToolbar";
import { BrowserChrome } from "../browser/components/BrowserChrome";
import { BrowserNativeSecurityNotice } from "../browser/components/BrowserNativeSecurityNotice";
import type { BrowserHistoryDateFilter, BrowserHistoryScope } from "../browser/components/BrowserHistorySidecar";
import { clearScopedBrowserHistory, type BrowserHistoryClearStatus } from "../browser/historyClear";
import {
  browserHistoryEntriesForScope,
  type BrowserHistoryScope as BrowserHistoryClearScope,
} from "../browser/historyScope";
import { EngineViewport } from "../browser/components/EngineViewport";
import {
  BrowserAdFilterMenu,
  BrowserOptionsMenu,
  BrowserPageSaveMenu,
  type BrowserColorMode,
} from "../browser/components/BrowserMenus";
import {
  buildVaultApprovalPrompts,
  vaultPromptSummaryText,
  type VaultApprovalPrompt,
} from "../lib/vault-approval-prompts";
import { isTrustedShellxUserEvent, type ShellxUserEventLike } from "../lib/trusted-user-event";
import {
  browserVisibleAdMode,
  type BrowserProfile,
  type BrowserShieldSettings,
  type BrowserTabShieldState,
  type BrowserVisibleAdMode,
} from "../browser/types";
import {
  runBrowserDebugClickSelector,
  runBrowserDebugDragSelector,
  runBrowserDebugInputSelector,
} from "../browser/debugBridge";
import { useBrowserState, type BrowserRightPanelPatch } from "../browser/hooks/useBrowserState";
import { useBrowserCowork } from "../browser/hooks/useBrowserCowork";
import { useBrowserBookmarks } from "../browser/hooks/useBrowserBookmarks";
import { useBrowserPageActions } from "../browser/hooks/useBrowserPageActions";
import { useBrowserPersonalLock } from "../browser/hooks/useBrowserPersonalLock";
import { useBrowserShellEffects } from "../browser/hooks/useBrowserShellEffects";
import { useBrowserSidebarResize } from "../browser/hooks/useBrowserSidebarResize";
import { selectBrowserHandoffTask, useBrowserTabLeases, useBrowserTabs } from "../browser/hooks/useBrowserTabs";
import { useBrowserTasks } from "../browser/hooks/useBrowserTasks";
import { useBrowserVaultFill } from "../browser/hooks/useBrowserVaultFill";
import { useNativeEngineSync } from "../browser/hooks/useNativeEngineSync";
import {
  vaultPromptDebugSuffix,
  vaultPromptEntityId,
  vaultPromptIcon,
} from "../browser/vaultPromptPresentation";
import type { RawEventFrame } from "../types/acp";
import { DebugHighlightOverlay } from "./DebugHighlightOverlay";
import { LazySurface } from "./LazySurface";
import {
  DEFAULT_HOME_URL,
  initialColorMode,
  initialDownloadFolder,
  initialHomeUrl,
  persistBrowserColorMode,
  persistBrowserHomeUrl,
} from "../browser/browserPreferences";
import {
  AGENT_DEFAULT_PROFILE_ID, BROWSER_ACTION_ENDPOINT, CHAT_PANEL, DOWNLOADS_MENU,
  INLINE_SURFACE, PIN_ONLY_AUTH, USER_DEFAULT_PROFILE_ID, VAULT_FILL_MENU,
} from "../browser/browserAppConstants";
import {
  bookmarkUrl,
  browserLogLevelClass,
  browserPageSecurityFromUrl,
  browserProfileLabel,
  browserProfileMarker,
  browserProfileShortLabel,
  browserTabShieldsFromUrl,
  browserTrustIcon,
  browserTrustLabel,
  currentPageUrlForSave,
  defaultPersonalLockSettings,
  formatHistoryTime,
  formatLogLocation,
  formatReceiptTime,
  safeBrowserStatusUrl,
} from "../browser/browserPresentation";

type BrowserSectionId = "tasks" | "console" | "receipts";
type BrowserHeaderMenuId = "history" | "save" | "ads" | "shields" | "downloads" | "vaultFill";

const BookmarkSidecar = lazy(() => import("../browser/components/BookmarkSidecar"));
const BrowserHistorySidecar = lazy(() => import("../browser/components/BrowserHistorySidecar")
  .then((module) => ({ default: module.BrowserHistorySidecar })));
const DownloadSidecar = lazy(() => import("../browser/components/DownloadSidecar")
  .then((module) => ({ default: module.DownloadSidecar })));
const BrowserShieldsPanel = lazy(() => import("../browser/components/BrowserShieldsPanel")
  .then((module) => ({ default: module.BrowserShieldsPanel })));
const BrowserVaultFillPanel = lazy(() => import("../browser/components/BrowserVaultFillPanel")
  .then((module) => ({ default: module.BrowserVaultFillPanel })));
const BrowserTabHandoffConfirmation = lazy(() => import("../browser/components/BrowserTabHandoffConfirmation").then((module) => ({ default: module.BrowserTabHandoffConfirmation })));
type BrowserRightPanelId = "chat" | "requests" | "actions" | "evidence" | "errors";

export function ShellxBrowserApp(): JSX.Element {
  const engineSlotRef = useRef<HTMLDivElement | null>(null);
  const previousVaultPromptCountRef = useRef<number | null>(null);
  const browserCoworkSessionEventRef = useRef<(frame: RawEventFrame) => void>(() => undefined);
  const browserCoworkUiStateRef = useRef<(state: unknown) => void>(() => undefined);
  const [address, setAddress] = useState("");
  const [addressEditing, setAddressEditing] = useState(false);
  const [homeUrl, setHomeUrl] = useState(initialHomeUrl);
  const [profileId, setProfileId] = useState(USER_DEFAULT_PROFILE_ID);
  const [busy, setBusy] = useState(false);
  const [taskControlBusy, setTaskControlBusy] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [headerMenu, setHeaderMenu] = useState<BrowserHeaderMenuId | null>(null);
  const [historyScope, setHistoryScope] = useState<BrowserHistoryScope>("user");
  const [historySearch, setHistorySearch] = useState("");
  const [historyDateFilter, setHistoryDateFilter] = useState<BrowserHistoryDateFilter>("all");
  const [historyClearStatus, setHistoryClearStatus] = useState<BrowserHistoryClearStatus | null>(null);
  const [rightPanelTab, setRightPanelTab] = useState<BrowserRightPanelId>(CHAT_PANEL);
  const [addressCopied, setAddressCopied] = useState(false);
  const [colorMode, setColorMode] = useState<BrowserColorMode>(initialColorMode);
  const [defaultDownloadFolder, setDefaultDownloadFolder] = useState(initialDownloadFolder);
  const [showRightSidebar, setShowRightSidebar] = useState(true);
  const [rightSidebarWidth, setRightSidebarWidth] = useState(360);
  const { startRightSidebarResize, resizeRightSidebarFromKeyboard } =
    useBrowserSidebarResize(rightSidebarWidth, setRightSidebarWidth);
  const [bookmarkManagerOpen, setBookmarkManagerOpen] = useState(false);
  const [openToolbarFolderId, setOpenToolbarFolderId] = useState<string | null>(null);
  const [dismissedVaultDepositIds, setDismissedVaultDepositIds] = useState<Set<string>>(() => new Set());
  const [collapsedSections, setCollapsedSections] = useState<Record<BrowserSectionId, boolean>>({
    tasks: false,
    console: false,
    receipts: false,
  });
  const browserTabLeases = useBrowserTabLeases();
  const handlePendingStartUrl = useCallback((url: string) => {
    if (!address) setAddress(url);
  }, [address]);
  const handleMissingProfile = useCallback((profiles: BrowserProfile[]) => {
    setProfileId(
      profiles.find((profile) => profile.profileId === USER_DEFAULT_PROFILE_ID)?.profileId ??
        profiles.find((profile) => profile.agentDefault)?.profileId ??
        AGENT_DEFAULT_PROFILE_ID,
    );
  }, []);
  const handleRightPanelPatch = useCallback((tab: BrowserRightPanelPatch) => {
    setRightPanelTab(tab);
  }, []);
  const handleBrowserSessionEvent = useCallback((frame: RawEventFrame) => browserCoworkSessionEventRef.current(frame), []);
  const handleBrowserCoworkUiState = useCallback((state: unknown) => browserCoworkUiStateRef.current(state), []);
  const {
    state,
    refresh,
    error,
    setError,
    debugHighlights,
  } = useBrowserState({
    address,
    profileId,
    rightPanelTab,
    historyOpen: headerMenu === "history",
    bookmarksOpen: bookmarkManagerOpen,
    transfersOpen: headerMenu === DOWNLOADS_MENU,
    onPendingStartUrl: handlePendingStartUrl,
    onMissingProfile: handleMissingProfile,
    onLiveTabsChanged: browserTabLeases.handleLiveTabsChanged,
    onRightPanelPatch: handleRightPanelPatch,
    onDebugClick: runBrowserDebugClickSelector,
    onDebugInput: runBrowserDebugInputSelector,
    onDebugDrag: runBrowserDebugDragSelector,
    onSessionEvent: handleBrowserSessionEvent,
    onCoworkUiState: handleBrowserCoworkUiState,
  });

  const activeTask = useMemo(() => {
    if (!state?.activeTaskId) return null;
    return state.tasks.find((task) => task.taskId === state.activeTaskId) ?? null;
  }, [state]);
  const browserCowork = useBrowserCowork({
    activeTask,
    enabled: showRightSidebar && rightPanelTab === CHAT_PANEL,
  });
  const browserTasks = useBrowserTasks({
    activeTask,
    address,
    agentDefaultProfileId: AGENT_DEFAULT_PROFILE_ID,
    autonomy: "assistedAutonomous",
    busy,
    profileId,
    refresh,
    runBusy: (action) => withBusy(action),
    runTaskControl: (action) => withTaskControl(action),
    sendPrompt: browserCowork.sendPrompt,
    setError,
    setProfileId,
    showChat: () => setRightPanelTab(CHAT_PANEL),
    userDefaultProfileId: USER_DEFAULT_PROFILE_ID,
  });
  browserCoworkSessionEventRef.current = browserCowork.onSessionEvent;
  browserCoworkUiStateRef.current = browserCowork.onUiState;
  const tabs = state?.tabs ?? [];
  const activeBrowserTab = useMemo(() => {
    if (!state?.activeBrowserTabId) return tabs.find((tab) => tab.active) ?? null;
    return tabs.find((tab) => tab.browserTabId === state.activeBrowserTabId) ?? null;
  }, [state?.activeBrowserTabId, tabs]);
  const activeBrowserTabTerminal = ["completed", "blocked", "aborted"].includes(activeBrowserTab?.status ?? "");
  const activeTaskForActiveTab = activeBrowserTab?.taskId === activeTask?.taskId ? activeTask : null;
  const manualVaultFillAllowed = (activeBrowserTab?.ownerKind ?? "user") === "user";
  const personalLock = state?.personalLock ?? defaultPersonalLockSettings();
  const browserPersonalLock = useBrowserPersonalLock({
    lock: personalLock,
    onCloseTransientUi: () => {
      setHeaderMenu(null);
      setOptionsOpen(false);
      setOpenToolbarFolderId(null);
    },
    refresh,
    runBusy: (action) => withBusy(action),
    setError,
  });
  const browserTabs = useBrowserTabs({
    activeBrowserTab,
    activeTask: selectBrowserHandoffTask(activeTask, state?.tasks ?? []),
    homeUrl,
    leases: browserTabLeases.leases,
    personalBrowserLocked: personalLock.enabled && personalLock.locked,
    profiles: state?.profiles ?? [],
    runBusy: (action) => withBusy(action),
    setAddress,
    setError,
    setLeases: browserTabLeases.setLeases,
    setProfileId,
    showPersonalLockBlockedNotice: browserPersonalLock.showBlockedNotice,
    tabs,
    userDefaultProfileId: USER_DEFAULT_PROFILE_ID,
  });
  const personalTabLocked =
    personalLock.enabled && personalLock.locked && activeBrowserTab?.profileId === USER_DEFAULT_PROFILE_ID;
  const headerProfileId = activeBrowserTab?.profileId ?? profileId;
  const headerProfile = useMemo(() => {
    return (state?.profiles ?? []).find((profile) => profile.profileId === headerProfileId) ?? null;
  }, [headerProfileId, state?.profiles]);
  const engineProfileId = activeBrowserTab?.profileId ?? profileId;
  const engineUrl = tabs.length === 0
    ? "about:blank"
    : activeBrowserTab
      ? (activeBrowserTab.url?.trim() || "about:blank")
      : activeTask?.currentUrl?.trim() || address.trim() || state?.pendingStartUrl?.trim() || "";
  const addressSourceUrl = useMemo(() => {
    if (tabs.length === 0) return "";
    return (
      state?.engine?.url?.trim() ||
      activeBrowserTab?.url?.trim() ||
      activeTask?.currentUrl?.trim() ||
      state?.pendingStartUrl?.trim() ||
      ""
    );
  }, [activeBrowserTab?.url, activeTask?.currentUrl, state?.engine?.url, state?.pendingStartUrl, tabs.length]);
  const activeSecurityState = useMemo(() => {
    return activeBrowserTab?.securityState ?? browserPageSecurityFromUrl(currentPageUrlForSave(state, activeTask, activeBrowserTab, address));
  }, [activeBrowserTab, activeTask, address, state]);
  const activeShieldState = useMemo(() => {
    const derived = browserTabShieldsFromUrl(state?.shields, currentPageUrlForSave(state, activeTask, activeBrowserTab, address));
    return {
      ...derived,
      blockedAdTrackerCount: activeBrowserTab?.shields?.blockedAdTrackerCount ?? derived.blockedAdTrackerCount,
    };
  }, [activeBrowserTab, activeTask, address, state]);
  const bookmarks = state?.bookmarks ?? [];
  const bookmarkToolbar = state?.bookmarkToolbar ?? [];
  const openToolbarFolder = useMemo(
    () => bookmarkToolbar.find((item) => item.kind === "folder" && item.bookmarkId === openToolbarFolderId) ?? null,
    [bookmarkToolbar, openToolbarFolderId],
  );
  const historyEntries = state?.history ?? [];
  const enginePool = state?.enginePool ?? null;
  const userHistory = useMemo(() => browserHistoryEntriesForScope("user", historyEntries), [historyEntries]);
  const agentHistory = useMemo(() => browserHistoryEntriesForScope("agent", historyEntries), [historyEntries]);
  const tasks = state?.tasks ?? [];
  const receipts = state?.receipts ?? [];
  const sessionGrants = state?.sessionGrants ?? [];
  const vaultDeposits = state?.vaultDeposits ?? [];
  const vaultPromptTaskId = activeTask?.taskId ?? activeBrowserTab?.taskId ?? null;
  const scopedSessionGrants = useMemo(
    () => vaultPromptTaskId
      ? sessionGrants.filter((grant) => !grant.taskId || grant.taskId === vaultPromptTaskId)
      : sessionGrants,
    [sessionGrants, vaultPromptTaskId],
  );
  const scopedVaultDeposits = useMemo(
    () => vaultPromptTaskId
      ? vaultDeposits.filter((deposit) => !deposit.taskId || deposit.taskId === vaultPromptTaskId)
      : vaultDeposits,
    [vaultDeposits, vaultPromptTaskId],
  );
  const vaultPrompts = useMemo(
    () => buildVaultApprovalPrompts({
      sessionGrants: scopedSessionGrants,
      vaultDeposits: scopedVaultDeposits,
      dismissedDepositIds: dismissedVaultDepositIds,
    }),
    [dismissedVaultDepositIds, scopedSessionGrants, scopedVaultDeposits],
  );
  useEffect(() => {
    const previous = previousVaultPromptCountRef.current;
    previousVaultPromptCountRef.current = vaultPrompts.length;
    if (previous === null) return;
    if (vaultPrompts.length > previous && vaultPrompts.length > 0) {
      setShowRightSidebar(true);
      setRightPanelTab("requests");
    }
  }, [vaultPrompts.length]);
  const downloads = state?.downloads ?? [];
  const uploads = state?.uploads ?? [];
  const transfers = useMemo(() => [...downloads, ...uploads], [downloads, uploads]);
  const activeTransferCount = transfers.filter((entry) => entry.status !== "completed" && entry.status !== "failed").length;
  const selectedAdMode = useMemo<BrowserVisibleAdMode>(() => {
    const privacy = state?.privacy;
    if (!privacy) return "balanced";
    return browserVisibleAdMode(
      privacy.profileModes?.find((mode) => mode.profileId === headerProfileId)?.adMode ?? privacy.globalAdMode,
    );
  }, [headerProfileId, state?.privacy]);
  const usesGlobalAdMode = !state?.privacy?.profileModes?.some((mode) => mode.profileId === headerProfileId);
  const browserChatMessages = browserCowork.messages;
  const currentPageUrl = currentPageUrlForSave(state, activeTask, activeBrowserTab, address);
  const browserVaultFill = useBrowserVaultFill({
    activeBrowserTab,
    addressEditing,
    engineLoadStatus: state?.engine?.loadStatus ?? null,
    engineUrl: state?.engine?.url ?? null,
    headerMenuOpen: headerMenu !== null,
    manualFillAllowed: manualVaultFillAllowed,
    optionsOpen,
    pageUrl: currentPageUrl,
    personalTabLocked,
    vaultDepositCount: vaultDeposits.length,
    onCloseMenu: () => setHeaderMenu(null),
    onOpenMenu: () => setHeaderMenu(VAULT_FILL_MENU),
    runBusy: (action) => withBusy(action),
    setError,
  });
  const browserBookmarks = useBrowserBookmarks({
    actionContext: browserTabs.actionContext,
    activeTaskId: activeTask?.taskId ?? null,
    bookmarkToolbar,
    bookmarks,
    busy,
    currentPageTitle: state?.engine?.title ?? activeTask?.currentUrl ?? activeBrowserTab?.url ?? address.trim(),
    currentPageUrl,
    onCloseManager: () => setBookmarkManagerOpen(false),
    onOpenManager: () => setBookmarkManagerOpen(true),
    onNavigateToUrl: (url) => navigateToUrl(url),
    runBusy: (action) => withBusy(action),
    setError,
  });
  useBrowserShellEffects({
    activeTaskId: activeTask?.taskId ?? null,
    addressEditing,
    addressSourceUrl,
    colorMode,
    defaultDownloadFolder,
    homeUrl,
    refresh,
    setAddress,
    setDefaultDownloadFolder,
    setHeaderMenu,
    setOpenToolbarFolderId,
    setOptionsOpen,
  });

  useNativeEngineSync({
    enabled: inTauri() && tabs.length > 0 && !activeBrowserTabTerminal,
    slotRef: engineSlotRef,
    activeEngineId: activeBrowserTab?.engineId ?? null,
    activeBrowserTabId: activeBrowserTab?.browserTabId ?? null,
    profileId: engineProfileId,
    url: engineUrl || null,
    dependencies: [
      browserBookmarks.bookmarkManageMode,
      bookmarkManagerOpen,
      bookmarks.length,
      headerMenu,
      optionsOpen,
      rightSidebarWidth,
      showRightSidebar,
      state?.engine?.engineId,
      tabs.length,
    ],
    onError: setError,
  });

  async function withBusy(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (browserPersonalLock.isPolicyMessage(message)) {
        browserPersonalLock.showBlockedNotice();
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function withTaskControl(action: () => Promise<void>): Promise<void> {
    setTaskControlBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTaskControlBusy(false);
    }
  }
  const handleVaultPromptAction = (
    prompt: VaultApprovalPrompt,
    actionKind?: string,
    event?: ShellxUserEventLike,
  ) => {
    const action = actionKind || prompt.primaryAction?.kind;
    if (!action) return;

    if (action === "approveSessionGrant" || action === "denySessionGrant") {
      if (!isTrustedShellxUserEvent(event)) {
        setError("Vault approval decisions require a direct user click.");
        return;
      }
      const grantId = vaultPromptEntityId(prompt, "session-grant:");
      if (!grantId) return;
      void withBusy(async () => {
        await resolveBrowserSessionGrant({
          grantId,
          approved: action === "approveSessionGrant",
        });
      });
      return;
    }

    if (action === "openVault" || action === "dismissDeposit") {
      const depositId = vaultPromptEntityId(prompt, "vault-deposit:");
      if (!depositId) return;
      void withBusy(async () => {
        if (action === "openVault") {
          await openBrowserVaultPanel();
        }
        setDismissedVaultDepositIds((current) => {
          const next = new Set(current);
          next.add(depositId);
          return next;
        });
      });
    }
  };

  const submitAddress = (event: FormEvent) => {
    event.preventDefault();
    void navigateToUrl(address);
  };

  const navigateToUrl = (rawUrl: string) => {
    const url = rawUrl.trim();
    if (!url) return;
    setHeaderMenu(null);
    setOptionsOpen(false);
    setOpenToolbarFolderId(null);
    setAddress(url);
    void withBusy(async () => {
      if (activeTaskForActiveTab) {
        await browserApiPostJson(BROWSER_ACTION_ENDPOINT, {
          ...browserTabs.actionContext(),
          taskId: activeTaskForActiveTab.taskId,
          action: "navigate",
          url,
        });
      } else if (activeBrowserTab) {
        await browserApiPostJson(BROWSER_ACTION_ENDPOINT, {
          ...browserTabs.actionContext(),
          action: "navigate",
          url,
        });
      } else {
        if (personalLock.enabled && personalLock.locked) {
          browserPersonalLock.showBlockedNotice();
          return;
        }
        await browserApiPostJson("/browser/tabs/open", {
          profileId: USER_DEFAULT_PROFILE_ID,
          url,
        });
        setProfileId(USER_DEFAULT_PROFILE_ID);
      }
    });
  };

  const goHome = () => {
    void navigateToUrl(homeUrl.trim() || DEFAULT_HOME_URL);
  };

  const runAction = (action: string) => {
    if (!activeBrowserTab) return;
    void withBusy(async () => {
      await browserApiPostJson(BROWSER_ACTION_ENDPOINT, {
        ...browserTabs.actionContext(),
        ...(activeTaskForActiveTab ? { taskId: activeTaskForActiveTab.taskId } : {}),
        action,
      });
    });
  };

  const toggleBookmarksPanel = () => {
    const nextOpen = !bookmarkManagerOpen;
    setHeaderMenu(null);
    setOptionsOpen(false);
    setOpenToolbarFolderId(null);
    setBookmarkManagerOpen(nextOpen);
    if (nextOpen) browserBookmarks.setBookmarkManageMode(false);
  };

  const copyAddress = () => {
    const value = currentPageUrl;
    if (!value) return;
    void navigator.clipboard.writeText(value).then(
      () => {
        setAddressCopied(true);
        window.setTimeout(() => setAddressCopied(false), 1200);
      },
      (err) => setError(err instanceof Error ? err.message : String(err)),
    );
  };


  const { chooseDefaultDownloadFolder, requestChatExplainPage, requestPageSave } = useBrowserPageActions({
    actionContext: browserTabs.actionContext,
    activeBrowserTabId: activeBrowserTab?.browserTabId ?? null,
    activeTaskId: activeTaskForActiveTab?.taskId ?? null,
    defaultDownloadFolder,
    pageTitle: state?.engine?.title ?? activeBrowserTab?.title ?? activeTaskForActiveTab?.currentUrl ?? currentPageUrl,
    pageUrl: currentPageUrl,
    runBusy: withBusy,
    setDefaultDownloadFolder,
    setError,
    startBrowserTaskWithGoal: browserTasks.startBrowserTaskWithGoal,
    onExplainStart: () => {
      setHeaderMenu(null);
      setBookmarkManagerOpen(false);
      setOptionsOpen(false);
      setOpenToolbarFolderId(null);
      setShowRightSidebar(true);
      setRightPanelTab(CHAT_PANEL);
    },
    onSaveComplete: () => {
      setBookmarkManagerOpen(false);
      setOptionsOpen(false);
      setOpenToolbarFolderId(null);
      setHeaderMenu(DOWNLOADS_MENU);
      setRightPanelTab("actions");
    },
    onSaveStart: () => setHeaderMenu(null),
  });

  const clearHistory = (scope: BrowserHistoryClearScope): Promise<boolean> => clearScopedBrowserHistory({
    scope, historyEntries, busy, refresh, setBusy, setError, setStatus: setHistoryClearStatus,
  });

  const updateProfileAdMode = (mode: BrowserVisibleAdMode | null) => {
    void withBusy(async () => {
      await updateBrowserPrivacy(mode === null
        ? { profileId: headerProfileId, clearProfileAdMode: true }
        : { profileId: headerProfileId, profileAdMode: mode });
      setHeaderMenu(null);
    });
  };

  const setParallelAgents = (configuredParallelAgents: string) => {
    void withBusy(async () => {
      await browserApiPostJson("/browser/engine-pool", {
        configuredParallelAgents,
      });
    });
  };

  const updateGlobalShields = (patch: Partial<BrowserShieldSettings>) => {
    void withBusy(async () => {
      await updateBrowserShields(patch);
    });
  };

  const saveSiteShields = (patch: Partial<BrowserTabShieldState> = {}) => {
    const host = activeShieldState.host?.trim();
    if (!host) return;
    void withBusy(async () => {
      const request = {
        host,
        adTrackerMode: patch.effectiveAdTrackerMode ?? activeShieldState.effectiveAdTrackerMode,
        cookieMode: patch.effectiveCookieMode ?? activeShieldState.effectiveCookieMode,
        fingerprintingMode: patch.effectiveFingerprintingMode ?? activeShieldState.effectiveFingerprintingMode,
        httpsUpgradeEnabled: patch.httpsUpgradeEnabled ?? activeShieldState.httpsUpgradeEnabled,
        scriptBlockingEnabled: patch.scriptBlockingEnabled ?? activeShieldState.scriptBlockingEnabled,
      };
      await updateBrowserSiteShields(request);
    });
  };

  const resetSiteShields = () => {
    const host = activeShieldState.host?.trim();
    if (!host) return;
    void withBusy(async () => {
      await removeBrowserSiteShields(host);
    });
  };

  const toggleSection = (section: BrowserSectionId) => {
    setCollapsedSections((current) => ({ ...current, [section]: !current[section] }));
  };
  const toggleHeaderMenu = (menu: BrowserHeaderMenuId) => {
    setOptionsOpen(false);
    setBookmarkManagerOpen(false);
    setOpenToolbarFolderId(null);
    if (menu === VAULT_FILL_MENU) {
      browserVaultFill.requestObservationRefresh();
    }
    setHeaderMenu((current) => (current === menu ? null : menu));
  };
  const toggleOptionsPanel = () => {
    setHeaderMenu(null);
    setBookmarkManagerOpen(false);
    setOpenToolbarFolderId(null);
    setOptionsOpen((current) => !current);
  };
  const selectRightPanelTab = (tab: BrowserRightPanelId) => {
    setHeaderMenu(null);
    setOptionsOpen(false);
    setBookmarkManagerOpen(false);
    setOpenToolbarFolderId(null);
    setRightPanelTab(tab);
  };
  const historySidecarOpen = headerMenu === "history";
  const downloadsSidecarOpen = headerMenu === DOWNLOADS_MENU;
  const settingsSidecarOpen = optionsOpen;
  const leftSidecarOpen = bookmarkManagerOpen || historySidecarOpen || downloadsSidecarOpen || settingsSidecarOpen;
  const leftSidecarWidth = settingsSidecarOpen ? 344 : 312;
  const gridClassName = [
    "shellx-browser-grid",
    leftSidecarOpen ? "with-left-sidecar" : "",
    showRightSidebar ? "" : "hide-right",
  ].filter(Boolean).join(" ");
  const gridStyle = {
    "--shellx-browser-left-sidecar-width": `${leftSidecarWidth}px`,
    "--shellx-browser-right-sidebar-width": `${rightSidebarWidth}px`,
  } as CSSProperties;

  const renderChromeMenuPanel = (): JSX.Element | null => {
    if (headerMenu === "shields") {
      return (
        <LazySurface label="Browser shields" onDismiss={() => setHeaderMenu(null)} variant={INLINE_SURFACE}>
          <BrowserShieldsPanel
            busy={busy}
            globalShields={state?.shields}
            activeShieldState={activeShieldState}
            onUpdateGlobal={updateGlobalShields}
            onSaveSite={saveSiteShields}
            onResetSite={resetSiteShields}
          />
        </LazySurface>
      );
    }

    if (headerMenu === "save") {
      return (
        <BrowserPageSaveMenu
          busy={busy}
          canSavePage={Boolean(currentPageUrl)}
          onRequestPageSave={requestPageSave}
        />
      );
    }

    if (headerMenu === "ads") {
      return (
        <BrowserAdFilterMenu
          busy={busy}
          selectedAdMode={selectedAdMode}
          usesGlobalDefault={usesGlobalAdMode}
          onSetAdMode={updateProfileAdMode}
          onUseGlobalDefault={() => updateProfileAdMode(null)}
        />
      );
    }

    if (headerMenu === VAULT_FILL_MENU) {
      return (
        <LazySurface label="Browser vault fill" onDismiss={() => setHeaderMenu(null)} variant={INLINE_SURFACE}>
          <BrowserVaultFillPanel
            busy={busy}
            candidates={browserVaultFill.candidates}
            error={browserVaultFill.error}
            onFillCandidate={browserVaultFill.fillCandidate}
          />
        </LazySurface>
      );
    }

    return null;
  };

  const chromeMenuPanel = renderChromeMenuPanel();
  const chromeMenuAlign = headerMenu === "shields" ? "align-left" : "align-right";
  const personalLockNoticeVisible = error?.startsWith("Personal Browser Lock is on.") === true;
  const updateColorMode = (mode: BrowserColorMode) => {
    persistBrowserColorMode(mode);
    setColorMode(mode);
  };
  const updateHomeUrl = (url: string) => {
    persistBrowserHomeUrl(url);
    setHomeUrl(url);
  };

  return (
    <main className="shellx-browser-app" data-color-mode={colorMode}>
      <DebugHighlightOverlay surface="browser" highlights={debugHighlights} />
      <BrowserChrome
        tabs={tabs}
        activeBrowserTab={activeBrowserTab}
        draggedTabId={browserTabs.draggedTabId}
        tabLeases={browserTabLeases.leases}
        busy={busy}
        showRightSidebar={showRightSidebar}
        address={address}
        addressCopied={addressCopied}
        activeSecurityState={activeSecurityState}
        headerMenu={headerMenu}
        optionsOpen={optionsOpen}
        bookmarkManagerOpen={bookmarkManagerOpen}
        canUseHistoryControls={Boolean(activeBrowserTab)}
        canUseCurrentPage={Boolean(currentPageUrl)}
        transferIntentCount={transfers.length}
        activeTransferCount={activeTransferCount}
        vaultFillCount={browserVaultFill.candidates.length || (browserVaultFill.error ? browserVaultFill.detectedFieldCount : 0)}
        headerProfileId={headerProfileId}
        headerProfileDescription={headerProfile?.description ?? null}
        personalLock={personalLock}
        personalLockAttention={browserPersonalLock.attention}
        canHandOffActiveTab={browserTabs.canHandOffActiveTab}
        canTakeBackActiveTab={browserTabs.canTakeBackActiveTab}
        chromeMenuPanel={chromeMenuPanel}
        chromeMenuAlign={chromeMenuAlign}
        browserProfileMarker={browserProfileMarker}
        browserProfileShortLabel={browserProfileShortLabel}
        browserTrustIcon={browserTrustIcon}
        browserTrustLabel={browserTrustLabel}
        onSetDraggedTabId={browserTabs.setDraggedTabId}
        onReorderTabs={browserTabs.reorderTabs}
        onFocusTab={browserTabs.focusTab}
        onCloseTab={browserTabs.closeTab}
        onNewTab={browserTabs.newTab}
        onToggleLockActiveTab={browserTabs.toggleLockActiveTab}
        onPersonalLockAction={browserPersonalLock.runAction}
        onHandOffActiveTab={browserTabs.handOffActiveTab}
        onTakeBackActiveTab={browserTabs.takeBackActiveTab}
        onShowRightSidebar={() => setShowRightSidebar(true)}
        onSubmitAddress={submitAddress}
        onRunAction={runAction}
        onGoHome={goHome}
        onToggleHeaderMenu={toggleHeaderMenu}
        onSetAddressEditing={setAddressEditing}
        onAddressChange={setAddress}
        onCopyAddress={copyAddress}
        onBookmarkCurrent={browserBookmarks.bookmarkCurrent}
        onToggleBookmarksPanel={toggleBookmarksPanel}
        onToggleOptions={toggleOptionsPanel}
      />

      {browserTabs.handoffConfirmation && <LazySurface label="Browser tab handoff" onDismiss={browserTabs.cancelHandOffActiveTab}><BrowserTabHandoffConfirmation busy={busy} confirmation={browserTabs.handoffConfirmation} status={browserTabs.handoffStatus} onCancel={browserTabs.cancelHandOffActiveTab} onConfirm={browserTabs.confirmHandOffActiveTab} /></LazySurface>}
      {error && (
        <div
          className={`shellx-browser-error ${personalLockNoticeVisible ? "shellx-browser-lock-notice" : ""}`}
          data-debug-id={personalLockNoticeVisible ? "shellx-browser-personal-lock-notice" : "shellx-browser-error"}
          role="alert"
        >
          <span>{error}</span>
          {personalLockNoticeVisible && (
            <button
              type="button"
              className="settings-pill"
              onClick={(event) => browserPersonalLock.runAction("unlock", browserPersonalLock.pinDraft, event)}
              disabled={personalLock.authMode === PIN_ONLY_AUTH && personalLock.pinConfigured && !browserPersonalLock.pinDraft.trim()}
              data-debug-id="shellx-browser-personal-lock-notice-unlock"
            >
              Unlock
            </button>
          )}
        </div>
      )}

      <BrowserNativeSecurityNotice capabilities={state?.nativeSecurity} />

      <BookmarkToolbar
        bookmarkToolbar={bookmarkToolbar}
        openToolbarFolder={openToolbarFolder}
        openToolbarFolderId={openToolbarFolderId}
        bookmarkUrl={bookmarkUrl}
        onOpenToolbarBookmark={browserBookmarks.openBookmark}
        onSetOpenToolbarFolderId={setOpenToolbarFolderId}
      />

      <div className={gridClassName} style={gridStyle}>
        {settingsSidecarOpen && (
          <BrowserOptionsMenu
            colorMode={colorMode}
            homeUrl={homeUrl}
            profileId={profileId}
            profiles={state?.profiles ?? []}
            configuredParallelAgents={enginePool?.limits?.configuredParallelAgents ?? "auto"}
            showRightSidebar={showRightSidebar}
            personalLock={personalLock}
            personalLockPinDraft={browserPersonalLock.pinDraft}
            profileLabel={browserProfileLabel}
            onColorModeChange={updateColorMode}
            onHomeUrlChange={updateHomeUrl}
            onProfileChange={setProfileId}
            onParallelAgentsChange={setParallelAgents}
            onShowRightSidebarChange={setShowRightSidebar}
            onPersonalLockPatch={browserPersonalLock.updateSettings}
            onPersonalLockAction={browserPersonalLock.runAction}
            onPersonalLockPinDraftChange={browserPersonalLock.setPinDraft}
            onClose={() => setOptionsOpen(false)}
          />
        )}

        {historySidecarOpen && <LazySurface label="Browser history" onDismiss={() => setHeaderMenu(null)} variant={INLINE_SURFACE}><BrowserHistorySidecar
          open
          busy={busy}
          historyScope={historyScope}
          historySearch={historySearch}
          historyDateFilter={historyDateFilter}
          historyEntries={historyEntries}
          userHistory={userHistory}
          agentHistory={agentHistory}
          formatHistoryTime={formatHistoryTime}
          onHistoryScopeChange={(scope) => {
            setHistoryScope(scope);
            setHistoryClearStatus(null);
          }}
          onHistorySearchChange={setHistorySearch}
          onHistoryDateFilterChange={setHistoryDateFilter}
          historyClearStatus={historyClearStatus}
          onClearHistory={clearHistory}
          onNavigateToUrl={navigateToUrl}
          onClose={() => setHeaderMenu(null)}
        /></LazySurface>}

        {downloadsSidecarOpen && <LazySurface label="Browser downloads" onDismiss={() => setHeaderMenu(null)} variant={INLINE_SURFACE}><DownloadSidecar
          open
          busy={busy}
          downloads={downloads}
          uploads={uploads}
          defaultDownloadFolder={defaultDownloadFolder}
          onDefaultDownloadFolderChange={setDefaultDownloadFolder}
          onChooseDefaultDownloadFolder={chooseDefaultDownloadFolder}
          onClose={() => setHeaderMenu(null)}
        /></LazySurface>}

        {bookmarkManagerOpen && <LazySurface label="Browser bookmarks" onDismiss={() => setBookmarkManagerOpen(false)} variant={INLINE_SURFACE}><BookmarkSidecar
          open={bookmarkManagerOpen}
          busy={busy}
          bookmarkManageMode={browserBookmarks.bookmarkManageMode}
          bookmarks={bookmarks}
          rootBookmarks={browserBookmarks.rootBookmarks}
          bookmarkFolders={browserBookmarks.bookmarkFolders}
          bookmarkChildrenByParent={browserBookmarks.bookmarkChildrenByParent}
          bookmarkDraftLabel={browserBookmarks.bookmarkDraftLabel}
          bookmarkDraftUrl={browserBookmarks.bookmarkDraftUrl}
          bookmarkDraftParentId={browserBookmarks.bookmarkDraftParentId}
          bookmarkDeleteId={browserBookmarks.bookmarkDeleteId}
          bookmarkRenameDrafts={browserBookmarks.bookmarkRenameDrafts}
          bookmarkUrlDrafts={browserBookmarks.bookmarkUrlDrafts}
          draggedBookmarkId={browserBookmarks.draggedBookmarkId}
          workflowPreview={browserBookmarks.workflowPreview}
          bookmarkUrl={bookmarkUrl}
          onOpenBookmark={browserBookmarks.openBookmark}
          onToggleBookmarkPin={browserBookmarks.toggleBookmarkPin}
          onCreateFolder={browserBookmarks.createBookmarkFolder}
          onCreateLink={browserBookmarks.createBookmarkLink}
          onDraftLabelChange={browserBookmarks.setBookmarkDraftLabel}
          onDraftUrlChange={browserBookmarks.setBookmarkDraftUrl}
          onDraftParentChange={browserBookmarks.setBookmarkDraftParentId}
          onRenameDraftChange={browserBookmarks.updateBookmarkRenameDraft}
          onResetRenameDraft={browserBookmarks.resetBookmarkRenameDraft}
          onUrlDraftChange={browserBookmarks.updateBookmarkUrlDraft}
          onResetUrlDraft={browserBookmarks.resetBookmarkUrlDraft}
          onCommitRename={browserBookmarks.commitBookmarkRename}
          onCommitUrl={browserBookmarks.commitBookmarkUrl}
          onDeleteBookmark={browserBookmarks.deleteBookmark}
          onDropBookmarkBefore={browserBookmarks.dropBookmarkBefore}
          onDropBookmarkIntoFolder={browserBookmarks.dropBookmarkIntoFolder}
          onStartBookmarkDrag={browserBookmarks.startBookmarkDrag}
          onStartBookmarkPointerDrag={browserBookmarks.startBookmarkPointerDrag}
          onSetBookmarkManagerOpen={setBookmarkManagerOpen}
          onSetBookmarkManageMode={browserBookmarks.setBookmarkManageMode}
        /></LazySurface>}

        <div className={`shellx-browser-engine-shell ${personalTabLocked ? "personal-locked" : ""}`}>
          <EngineViewport
            engineSlotRef={engineSlotRef}
            title={state?.engine?.title ?? (safeBrowserStatusUrl(activeTask?.currentUrl ?? address.trim()) || "Blank page")}
            loadStatus={state?.engine?.loadStatus ?? "mounting"}
            lastError={state?.engine?.lastError ?? null}
          />
          {personalTabLocked && (
            <div
              className={`shellx-browser-personal-lock-overlay ${personalLock.blurLockedTabs ? "cover" : ""}`}
              data-debug-id="shellx-browser-personal-lock-overlay"
            >
              <div>
                <strong>Personal tabs locked</strong>
                <span>Unlock personal tabs to view or use this page.</span>
              </div>
              {personalLock.authMode === PIN_ONLY_AUTH && personalLock.pinConfigured && (
                <input
                  type="password"
                  value={browserPersonalLock.pinDraft}
                  onChange={(event) => browserPersonalLock.setPinDraft(event.target.value)}
                  placeholder="PIN"
                  data-debug-id="shellx-browser-personal-lock-overlay-pin"
                />
              )}
              <button
                type="button"
                className="settings-pill active"
                onClick={(event) => browserPersonalLock.runAction("unlock", browserPersonalLock.pinDraft, event)}
                disabled={personalLock.authMode === PIN_ONLY_AUTH && personalLock.pinConfigured && !browserPersonalLock.pinDraft.trim()}
                data-debug-id="shellx-browser-personal-lock-overlay-unlock"
                data-shellx-release-observe="disabled"
              >
                Unlock personal tabs
              </button>
            </div>
          )}
        </div>

        <AgentSidebar
          show={showRightSidebar}
          rightSidebarWidth={rightSidebarWidth}
          rightPanelTab={rightPanelTab}
          goal={browserTasks.goal}
          busy={busy}
          taskControlBusy={taskControlBusy}
          activeTask={activeTask}
          browserChatMessages={browserChatMessages}
          coworkSessionLabel={browserCowork.sessionLabel}
          canSendCoworkMessage={browserCowork.canSend}
          vaultPromptSummary={vaultPromptSummaryText(vaultPrompts)}
          vaultPrompts={vaultPrompts}
          tasks={tasks}
          receipts={receipts}
          downloads={downloads}
          uploads={uploads}
          consoleLogs={state?.consoleLogs ?? []}
          collapsedSections={collapsedSections}
          formatReceiptTime={formatReceiptTime}
          formatLogLocation={formatLogLocation}
          browserLogLevelClass={browserLogLevelClass}
          vaultPromptIcon={vaultPromptIcon}
          vaultPromptDebugSuffix={vaultPromptDebugSuffix}
          canExplainPage={Boolean(currentPageUrl)}
          onResizeStart={startRightSidebarResize}
          onResizeKeyDown={resizeRightSidebarFromKeyboard}
          onHideRightSidebar={() => setShowRightSidebar(false)}
          onSelectRightPanelTab={selectRightPanelTab}
          onGoalChange={browserTasks.setGoal}
          onSubmitTask={browserTasks.submitTask}
          onSubmitTaskFromKeyboard={browserTasks.submitTaskFromKeyboard}
          onControlTask={browserTasks.controlTask}
          onFinishTask={browserTasks.finishTask}
          onToggleSection={toggleSection}
          onExplainPage={requestChatExplainPage}
          onVaultPromptAction={handleVaultPromptAction}
        />
      </div>
    </main>
  );
}
