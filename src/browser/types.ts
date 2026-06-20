export type BrowserAutonomy = "approvalFirst" | "assistedAutonomous" | "autonomous" | "unattendedWithPolicy";
export type BrowserAdMode = "off" | "balanced" | "strict" | "visualCleanCompatibility";
export type BrowserVisibleAdMode = Exclude<BrowserAdMode, "visualCleanCompatibility">;
export type BrowserShieldAdTrackerMode = "off" | "balanced" | "strict";
export type BrowserShieldCookieMode = "allowAll" | "blockThirdParty" | "blockAll";
export type BrowserShieldFingerprintingMode = "compatibility" | "strict";
export type BrowserBookmarkKind = "link" | "folder";
export type BrowserTabOwnerKind = "user" | "agent" | "delegatedToAgent";
export type BrowserPersonalLockAuthMode = "deviceAuthPreferred" | "pinOnly";

export function browserVisibleAdMode(mode?: BrowserAdMode | null): BrowserVisibleAdMode {
  return mode === "off" || mode === "strict" ? mode : "balanced";
}

export interface BrowserProfile {
  profileId: string;
  label: string;
  description: string;
  agentDefault: boolean;
  cookiesEnabled: boolean;
  persistent: boolean;
  storageRoot?: string | null;
}

export interface BrowserTabLock {
  leaseId: string;
  ownerAgentId: string;
  ownerRunId: string;
  scope: string;
  acquiredAtMs: number;
  heartbeatAtMs: number;
  expiresAtMs: number;
}

export interface BrowserPageSecurityState {
  level: string;
  scheme: string;
  host?: string | null;
  credentialEntryAllowed: boolean;
  requiresSeparateCredentialApproval: boolean;
  summary: string;
}

export interface BrowserShieldSettings {
  enabled: boolean;
  adTrackerMode: BrowserShieldAdTrackerMode;
  cookieMode: BrowserShieldCookieMode;
  fingerprintingMode: BrowserShieldFingerprintingMode;
  httpsUpgradeEnabled: boolean;
  scriptBlockingEnabled: boolean;
  siteOverrides: Array<{
    host: string;
    adTrackerMode: BrowserShieldAdTrackerMode;
    cookieMode: BrowserShieldCookieMode;
    fingerprintingMode: BrowserShieldFingerprintingMode;
    httpsUpgradeEnabled: boolean;
    scriptBlockingEnabled: boolean;
    updatedAtMs: number;
  }>;
  updatedAtMs: number;
}

export interface BrowserTabShieldState {
  host?: string | null;
  enabled: boolean;
  effectiveAdTrackerMode: BrowserShieldAdTrackerMode;
  effectiveCookieMode: BrowserShieldCookieMode;
  effectiveFingerprintingMode: BrowserShieldFingerprintingMode;
  httpsUpgradeEnabled: boolean;
  scriptBlockingEnabled: boolean;
  hasSiteOverride: boolean;
  blockedAdTrackerCount: number;
}

export interface BrowserTab {
  browserTabId: string;
  engineId: string;
  taskId?: string | null;
  profileId: string;
  url?: string | null;
  title?: string | null;
  status: string;
  active: boolean;
  securityState?: BrowserPageSecurityState | null;
  shields?: BrowserTabShieldState | null;
  engineWebviewLabel?: string | null;
  engineState?: "live" | "queued" | "parked" | "rehydrating" | "crashed";
  lastVisualCaptureAtMs?: number | null;
  requiresUserAttention?: boolean;
  storageRoot?: string | null;
  privacyMode: BrowserAdMode;
  ownerKind?: BrowserTabOwnerKind;
  delegatedTaskId?: string | null;
  delegatedGrantId?: string | null;
  lock?: BrowserTabLock | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface BrowserTask {
  taskId: string;
  profileId: string;
  goal: string;
  status: string;
  autonomy: BrowserAutonomy;
  currentUrl?: string | null;
  updatedAtMs: number;
}

export interface BrowserBookmark {
  bookmarkId: string;
  label: string;
  url?: string | null;
  category: string;
  kind: BrowserBookmarkKind;
  parentId?: string | null;
  toolbarPinned: boolean;
  toolbarOrder?: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface BrowserBookmarkToolbarItem {
  bookmarkId: string;
  label: string;
  kind: BrowserBookmarkKind;
  url?: string | null;
  children: BrowserBookmark[];
}

export interface BrowserHistoryEntry {
  historyId: string;
  taskId?: string | null;
  profileId: string;
  url: string;
  title?: string | null;
  visitedAtMs: number;
}

export interface BrowserReceipt {
  receiptId: string;
  kind: string;
  summary: string;
  t: number;
}

export interface BrowserConsoleLog {
  logId: string;
  taskId?: string | null;
  level: string;
  source: string;
  message: string;
  url?: string | null;
  line?: number | null;
  column?: number | null;
  t: number;
}

export interface BrowserPrivacySettings {
  globalAdMode?: BrowserAdMode;
  profileModes?: Array<{ profileId: string; adMode: BrowserAdMode }>;
  identityPolicy?: string;
  exposesShellxIdentity?: boolean;
  updatedAtMs?: number;
}

export interface BrowserPersonalLockSettings {
  enabled: boolean;
  timeoutMinutes: number;
  authMode: BrowserPersonalLockAuthMode;
  pinConfigured: boolean;
  blurLockedTabs: boolean;
  pauseDelegatedTabsWhenLocked: boolean;
  lockOnSleep: boolean;
  lockOnMinimize: boolean;
  locked: boolean;
  lockedAtMs?: number | null;
  lastTrustedUserActivityAtMs?: number | null;
  optInConfirmedAtMs?: number | null;
  updatedAtMs: number;
}

export interface BrowserTransferEntry {
  transferId: string;
  direction: "download" | "upload" | string;
  status: string;
  taskId?: string | null;
  browserTabId?: string | null;
  url?: string | null;
  filePath?: string | null;
  displayName?: string | null;
  finalPath?: string | null;
  mimeType?: string | null;
  contentKind?: string | null;
  bytes?: number | null;
  sha256?: string | null;
  sourceUrl?: string | null;
  destination?: string | null;
  retentionReason?: string | null;
  approvalId?: string | null;
  destinationOrigin?: string | null;
  refId?: string | null;
  reason: string;
  requestedAtMs: number;
  completedAtMs?: number | null;
}

export interface BrowserVaultDeposit {
  depositId: string;
  label: string;
  storageCommitHash: string;
  secretExposed: boolean;
  taskId?: string | null;
  sourceUrl?: string | null;
  createdAtMs?: number | null;
  serverReceipt?: { createdMs?: number | null } | null;
  receipt?: { t?: number | null } | null;
}

export interface BrowserSessionGrant {
  grantId: string;
  taskId?: string | null;
  fromProfileId: string;
  toProfileId: string;
  reason: string;
  status: string;
  ttlSeconds?: number | null;
  createdAtMs: number;
  resolvedAtMs?: number | null;
  appliedAtMs?: number | null;
}

export interface BrowserEngineSnapshot {
  engineId: string;
  mounted: boolean;
  webviewLabel: string;
  browserTabId?: string | null;
  taskId?: string | null;
  profileId?: string | null;
  url?: string | null;
  title?: string | null;
  loadStatus: string;
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
  lastError?: string | null;
  visibilityState?: "foreground" | "background" | "minimized" | "hidden";
  visualCapture?: "available" | "degraded" | "unavailable";
  updatedAtMs: number;
}

export interface BrowserEnginePoolSnapshot {
  engines: BrowserEngineSnapshot[];
  limits: {
    configuredParallelAgents: string;
    effectiveBackgroundEngines: number;
    maxBackgroundEngines: number;
    idleEngineTimeoutMinutes: number;
    disposableProfileCleanupMinutes: number;
    lowMemoryFallback: string;
  };
  resourcePressure: {
    status: string;
    detectedRamGb?: number | null;
    freeRamMb?: number | null;
    cpuPressure?: string | null;
    batterySaver?: boolean | null;
  };
  waiting: Array<unknown>;
  parkedTabs: string[];
  windowState: string;
  automationMode: string;
}

export interface BrowserState {
  profiles: BrowserProfile[];
  tabs: BrowserTab[];
  bookmarks: BrowserBookmark[];
  bookmarkToolbar: BrowserBookmarkToolbarItem[];
  history: BrowserHistoryEntry[];
  tasks: BrowserTask[];
  activeTaskId?: string | null;
  activeBrowserTabId?: string | null;
  windowOpen: boolean;
  pendingStartUrl?: string | null;
  engine?: BrowserEngineSnapshot | null;
  enginePool?: BrowserEnginePoolSnapshot | null;
  privacy: BrowserPrivacySettings;
  personalLock?: BrowserPersonalLockSettings;
  downloadFolder?: string | null;
  shields: BrowserShieldSettings;
  sessionGrants: BrowserSessionGrant[];
  vaultDeposits: BrowserVaultDeposit[];
  downloads: BrowserTransferEntry[];
  uploads: BrowserTransferEntry[];
  consoleLogs: BrowserConsoleLog[];
  receipts: BrowserReceipt[];
}
