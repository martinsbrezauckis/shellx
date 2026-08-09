import type {
  BrowserBookmark,
  BrowserBookmarkToolbarItem,
  BrowserConsoleLog,
  BrowserPageSecurityState,
  BrowserPageSaveKind,
  BrowserPersonalLockSettings,
  BrowserProfile,
  BrowserShieldSettings,
  BrowserState,
  BrowserTab,
  BrowserTabShieldState,
  BrowserTask,
} from "./types";
import type { BrowserObservationLike } from "./vaultFillCandidates";

export function browserProfileLabel(profile: BrowserProfile): string {
  if (profile.profileId === "agent-work") return `${profile.label} · default`;
  if (!profile.cookiesEnabled) return `${profile.label} · no cookies`;
  return profile.label;
}

export function browserProfileMarker(profileId: string): string {
  if (profileId === "personal") return "P";
  if (profileId === "task-disposable") return "D";
  if (profileId === "agent-work") return "A";
  return profileId.slice(0, 1).toUpperCase() || "?";
}

export function browserProfileShortLabel(profileId: string): string {
  if (profileId === "personal") return "Personal";
  if (profileId === "task-disposable") return "Disposable";
  if (profileId === "agent-work") return "Agent";
  return profileId;
}

export function bookmarkUrl(bookmark: Pick<BrowserBookmark, "url"> | Pick<BrowserBookmarkToolbarItem, "url">): string {
  return bookmark.url?.trim() ?? "";
}

export function compareBookmarksForPanel(a: BrowserBookmark, b: BrowserBookmark): number {
  const orderDelta = (a.toolbarOrder ?? Number.MAX_SAFE_INTEGER) - (b.toolbarOrder ?? Number.MAX_SAFE_INTEGER);
  if (orderDelta !== 0) return orderDelta;
  const labelDelta = a.label.toLocaleLowerCase().localeCompare(b.label.toLocaleLowerCase());
  if (labelDelta !== 0) return labelDelta;
  return a.bookmarkId.localeCompare(b.bookmarkId);
}

export function currentPageUrlForSave(
  state: BrowserState | null,
  activeTask: BrowserTask | null,
  activeTab: BrowserTab | null,
  address: string,
): string {
  return (
    state?.engine?.url?.trim() ||
    activeTab?.url?.trim() ||
    activeTask?.currentUrl?.trim() ||
    address.trim()
  );
}

function pageSaveSlugPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "page";
}

export function pageSaveBaseName(rawUrl: string, title?: string | null): string {
  let host = "browser-page";
  try {
    const parsed = new URL(rawUrl.includes("://") ? rawUrl : `https://${rawUrl}`);
    host = parsed.hostname || host;
  } catch {
    host = rawUrl || host;
  }
  const titlePart = pageSaveSlugPart(title || "");
  const hostPart = pageSaveSlugPart(host);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  return `${hostPart}-${titlePart}-${stamp}`;
}

export function browserLinksFromObservation(observation?: BrowserObservationLike | null): Array<{ label: string; url: string; visible: boolean; refId?: string }> {
  return (observation?.refs ?? [])
    .filter((ref) => ref.role === "link" && typeof ref.value === "string" && ref.value.trim())
    .map((ref) => ({
      label: ref.label || ref.value || "Link",
      url: String(ref.value).trim(),
      visible: ref.visible !== false,
      refId: ref.refId,
    }));
}

export function safeBrowserStatusUrl(rawUrl?: string | null): string {
  const raw = rawUrl?.trim();
  if (!raw) return "";
  try {
    const normalized = raw.startsWith("about:") || raw.includes("://") ? raw : `https://${raw}`;
    const parsed = new URL(normalized);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return raw.split(/[?#]/)[0] ?? "";
  }
}

function boundedBrowserExplainExcerpt(observation: BrowserObservationLike | null): string {
  const source = observation?.markdown || observation?.text || "";
  const cleaned = source.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned.length > 1400 ? `${cleaned.slice(0, 1400).trim()}...` : cleaned;
}

export function browserExplainGoal(input: {
  url: string;
  title?: string | null;
  observation?: BrowserObservationLike | null;
}): string {
  const safeUrl = safeBrowserStatusUrl(input.observation?.url || input.url);
  const title = (input.observation?.title || input.title || "").trim();
  const excerpt = boundedBrowserExplainExcerpt(input.observation ?? null);
  const lines = [
    "Explain the current browser page for the user.",
    safeUrl ? `URL: ${safeUrl}` : "",
    title ? `Title: ${title}` : "",
    excerpt ? `Page excerpt: ${excerpt}` : "",
    "Summarize what the page is for, the important visible facts/actions, and any security or trust concerns. Do not assume access to user secrets or hidden session data unless the user explicitly grants it.",
  ];
  return lines.filter(Boolean).join("\n");
}

export function browserPageSecurityFromUrl(rawUrl?: string | null): BrowserPageSecurityState {
  const raw = rawUrl?.trim();
  if (!raw) {
    return {
      level: "unknown",
      scheme: "unknown",
      credentialEntryAllowed: false,
      requiresSeparateCredentialApproval: true,
      summary: "Page security is unknown",
    };
  }
  const normalized = raw.startsWith("about:") || raw.includes("://") ? raw : `https://${raw}`;
  try {
    const parsed = new URL(normalized);
    const scheme = parsed.protocol.replace(":", "").toLowerCase();
    const host = parsed.hostname || null;
    if (scheme === "https") {
      return {
        level: "secure",
        scheme,
        host,
        credentialEntryAllowed: true,
        requiresSeparateCredentialApproval: false,
        summary: "Secure HTTPS page",
      };
    }
    if (scheme === "http") {
      const local =
        host === "localhost" ||
        host?.endsWith(".localhost") ||
        host?.endsWith(".local") ||
        host === "127.0.0.1" ||
        host === "::1";
      return {
        level: local ? "localHttp" : "insecureHttp",
        scheme,
        host,
        credentialEntryAllowed: false,
        requiresSeparateCredentialApproval: true,
        summary: local ? "Local page without HTTPS" : "Not secure: HTTP page",
      };
    }
    return {
      level: scheme === "about" ? "browserInternal" : "unknown",
      scheme,
      host,
      credentialEntryAllowed: false,
      requiresSeparateCredentialApproval: true,
      summary: scheme === "about" ? "Browser internal page" : "Page security is unknown",
    };
  } catch {
    return {
      level: "unknown",
      scheme: "unknown",
      credentialEntryAllowed: false,
      requiresSeparateCredentialApproval: true,
      summary: "Page security is unknown",
    };
  }
}

export function browserTabShieldsFromUrl(shields: BrowserShieldSettings | undefined, rawUrl?: string | null): BrowserTabShieldState {
  const defaults: BrowserShieldSettings = shields ?? {
    enabled: true,
    adTrackerMode: "balanced",
    cookieMode: "blockThirdParty",
    fingerprintingMode: "compatibility",
    httpsUpgradeEnabled: true,
    scriptBlockingEnabled: false,
    siteOverrides: [],
    updatedAtMs: 0,
  };
  const security = browserPageSecurityFromUrl(rawUrl);
  const host = security.host ?? null;
  const siteOverride = host ? defaults.siteOverrides.find((override) => override.host === host) : undefined;
  return {
    host,
    enabled: defaults.enabled,
    effectiveAdTrackerMode: siteOverride?.adTrackerMode ?? defaults.adTrackerMode,
    effectiveCookieMode: siteOverride?.cookieMode ?? defaults.cookieMode,
    effectiveFingerprintingMode: siteOverride?.fingerprintingMode ?? defaults.fingerprintingMode,
    httpsUpgradeEnabled: siteOverride?.httpsUpgradeEnabled ?? defaults.httpsUpgradeEnabled,
    scriptBlockingEnabled: siteOverride?.scriptBlockingEnabled ?? defaults.scriptBlockingEnabled,
    hasSiteOverride: Boolean(siteOverride),
    blockedAdTrackerCount: 0,
  };
}

export function browserTrustLabel(security: BrowserPageSecurityState): string {
  switch (security.level) {
    case "secure":
      return "Secure";
    case "localHttp":
      return "Local";
    case "insecureHttp":
      return "Not secure";
    default:
      return "Unknown";
  }
}

export function browserTrustIcon(security: BrowserPageSecurityState): "lock" | "shield-alert" | "alert" {
  if (security.level === "secure") return "lock";
  if (security.level === "insecureHttp") return "shield-alert";
  return "alert";
}

export function defaultPersonalLockSettings(): BrowserPersonalLockSettings {
  return {
    enabled: false,
    timeoutMinutes: 30,
    authMode: "deviceAuthPreferred",
    pinConfigured: false,
    blurLockedTabs: true,
    pauseDelegatedTabsWhenLocked: true,
    lockOnSleep: true,
    lockOnMinimize: false,
    locked: false,
    lockedAtMs: null,
    lastTrustedUserActivityAtMs: null,
    optInConfirmedAtMs: null,
    updatedAtMs: 0,
  };
}

export function pageSaveReason(kind: BrowserPageSaveKind): string {
  if (kind === "screenshot") return "userPageSave:screenshot";
  if (kind === "fullPageScreenshot") return "userPageSave:fullPageScreenshot";
  if (kind === "markdown") return "userPageSave:markdown";
  if (kind === "linksJson") return "userPageSave:linksJson";
  if (kind === "snapshotJson") return "userPageSave:snapshotJson";
  if (kind === "media") return "userPageSave:media";
  if (kind === "code") return "userPageSave:code";
  return "userPageSave:workingSiteCopy";
}

export function pageSaveDisplayName(kind: BrowserPageSaveKind): string {
  switch (kind) {
    case "screenshot":
      return "Window screenshot";
    case "fullPageScreenshot":
      return "Full-page screenshot";
    case "markdown":
      return "Markdown";
    case "linksJson":
      return "Links JSON";
    case "snapshotJson":
      return "Snapshot bundle";
    case "media":
      return "Media copy job";
    case "code":
      return "Code copy job";
    case "site":
      return "Site copy job";
  }
}

export function formatReceiptTime(t: number): string {
  if (!Number.isFinite(t) || t <= 0) return "";
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatHistoryTime(t: number): string {
  if (!Number.isFinite(t) || t <= 0) return "";
  return new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function formatLogLocation(log: BrowserConsoleLog): string {
  const bits = [log.source || "browser-runtime"];
  if (log.url) bits.push(log.url);
  if (Number.isFinite(log.line)) {
    bits.push(`:${log.line}${Number.isFinite(log.column) ? `:${log.column}` : ""}`);
  }
  return bits.join(" ");
}

export function browserLogLevelClass(level: string): string {
  const normalized = level.toLowerCase();
  if (normalized === "error") return "error";
  if (normalized === "warn" || normalized === "warning") return "warn";
  return "info";
}
