import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type JSX, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { inTauri } from "../lib/tauri-bridge";
import {
  browserApiDeleteJson,
  browserApiPostJson,
  clearBrowserHistoryCommand,
  copyBrowserLocalArtifact,
  delegateBrowserTabToAgent,
  fillUserVaultSecret,
  grantBrowserTransfer,
  listBrowserVaultKeys,
  openBrowserVaultPanel,
  removeBrowserSiteShields,
  resolveBrowserSessionGrant,
  takeBackBrowserTabFromAgent,
  updateBrowserDownloadFolder,
  updateBrowserTaskAutonomy,
  updateBrowserPersonalLock,
  updateBrowserPrivacy,
  updateBrowserShields,
  updateBrowserSiteShields,
  writeBrowserTextArtifact,
  type BrowserVaultKeyMeta,
} from "../browser/api";
import { AgentSidebar } from "../browser/components/AgentSidebar";
import { BookmarkSidecar, BookmarkToolbar } from "../browser/components/BookmarkSidecar";
import { BrowserChrome } from "../browser/components/BrowserChrome";
import { DownloadSidecar } from "../browser/components/DownloadSidecar";
import {
  BrowserHistorySidecar,
  type BrowserHistoryDateFilter,
  type BrowserHistoryScope,
} from "../browser/components/BrowserHistorySidecar";
import { EngineViewport } from "../browser/components/EngineViewport";
import {
  BrowserAdFilterMenu,
  BrowserOptionsMenu,
  BrowserPageSaveMenu,
  type BrowserColorMode,
  type BrowserEngineAutomationMode,
  type BrowserPageSaveKind,
} from "../browser/components/BrowserMenus";
import { BrowserShieldsPanel } from "../browser/components/BrowserShieldsPanel";
import {
  buildVaultApprovalPrompts,
  vaultPromptSummaryText,
  type VaultApprovalPrompt,
} from "../lib/vault-approval-prompts";
import { isTrustedShellxUserEvent, type ShellxUserEventLike } from "../lib/trusted-user-event";
import {
  browserVisibleAdMode,
  type BrowserAdMode,
  type BrowserAutonomy,
  type BrowserBookmark,
  type BrowserBookmarkToolbarItem,
  type BrowserConsoleLog,
  type BrowserPageSecurityState,
  type BrowserPersonalLockSettings,
  type BrowserProfile,
  type BrowserShieldSettings,
  type BrowserState,
  type BrowserTab,
  type BrowserTabShieldState,
  type BrowserTask,
  type BrowserTransferEntry,
  type BrowserVisibleAdMode,
} from "../browser/types";
import {
  runBrowserDebugClickSelector,
  runBrowserDebugDragSelector,
  runBrowserDebugInputSelector,
} from "../browser/debugBridge";
import { useBrowserState, type BrowserRightPanelPatch } from "../browser/hooks/useBrowserState";
import { useNativeEngineSync } from "../browser/hooks/useNativeEngineSync";
import { inferBrowserTaskStartUrl } from "../browser/taskIntent";
import { readSettingsLocal, persistSettings, type SettingsValues } from "./Settings";
import { DebugHighlightOverlay } from "./DebugHighlightOverlay";
import type { ShellIconName } from "./icons";

type BrowserSectionId = "tasks" | "console" | "receipts";
type BrowserHeaderMenuId = "history" | "save" | "ads" | "shields" | "downloads" | "vaultFill";
type BrowserRightPanelId = "chat" | "requests" | "actions" | "errors";
type BrowserImmediateSaveKind = "screenshot" | "fullPageScreenshot" | "markdown" | "linksJson" | "snapshotJson";

const DEFAULT_GOAL = "Browse the page, extract needed information, and report with receipts.";
const DEFAULT_HOME_URL = "https://example.com/";
const COLOR_MODE_STORAGE_KEY = "shellx-browser-color-mode";
const HOME_URL_STORAGE_KEY = "shellx-browser-home-url";
const DOWNLOAD_FOLDER_STORAGE_KEY = "shellx-browser-download-folder";
const USER_DEFAULT_PROFILE_ID = "personal";
const AGENT_DEFAULT_PROFILE_ID = "agent-work";
const UI_BROWSER_AGENT_ID = "shellx-browser-ui";
const UI_BROWSER_RUN_ID = "browser-window";

interface BrowserObservationRefLike {
  refId?: string;
  role?: string;
  label?: string;
  name?: string | null;
  value?: string | null;
  selector?: string | null;
  action?: string | null;
  visible?: boolean | null;
  editable?: boolean | null;
}

interface BrowserObservationLike {
  url?: string | null;
  title?: string | null;
  text?: string | null;
  markdown?: string | null;
  refs?: BrowserObservationRefLike[];
  domSummary?: Record<string, unknown> | null;
}

interface BrowserScreenshotLike {
  path: string;
  bytes: number;
  sha256: string;
  width?: number | null;
  height?: number | null;
  fullPage?: boolean;
  pageWidth?: number | null;
  pageHeight?: number | null;
  url?: string | null;
  title?: string | null;
}

interface BrowserActionResponseLike {
  ok?: boolean;
  status?: string;
  currentUrl?: string | null;
  message?: string | null;
  extractedText?: string | null;
  observation?: BrowserObservationLike | null;
  screenshot?: BrowserScreenshotLike | null;
}

type BrowserVaultFillFieldKind = "password" | "apiKey" | "token" | "secret";

interface BrowserVaultFillCandidate {
  id: string;
  key: string;
  label: string;
  description: string;
  userOnly: boolean;
  fieldKind: BrowserVaultFillFieldKind;
  fieldLabel: string;
  refId?: string;
  selector?: string;
  score: number;
}

function initialColorMode(): BrowserColorMode {
  const stored = window.localStorage.getItem(COLOR_MODE_STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "system") return stored;
  return "system";
}

function initialHomeUrl(): string {
  const stored = window.localStorage.getItem(HOME_URL_STORAGE_KEY)?.trim();
  return stored || DEFAULT_HOME_URL;
}

function initialDownloadFolder(): string {
  const settings = readSettingsLocal();
  const legacy = window.localStorage.getItem(DOWNLOAD_FOLDER_STORAGE_KEY)?.trim() ?? "";
  return settings.browserDownloadFolder.trim() || legacy;
}

function persistBrowserDownloadFolder(value: string): SettingsValues {
  const next = { ...readSettingsLocal(), browserDownloadFolder: value.trim() };
  persistSettings(next);
  window.localStorage.removeItem(DOWNLOAD_FOLDER_STORAGE_KEY);
  return next;
}

function browserProfileLabel(profile: BrowserProfile): string {
  if (profile.profileId === "agent-work") return `${profile.label} · default`;
  if (!profile.cookiesEnabled) return `${profile.label} · no cookies`;
  return profile.label;
}

function browserProfileMarker(profileId: string): string {
  if (profileId === "personal") return "P";
  if (profileId === "task-disposable") return "D";
  if (profileId === "agent-work") return "A";
  return profileId.slice(0, 1).toUpperCase() || "?";
}

function browserProfileShortLabel(profileId: string): string {
  if (profileId === "personal") return "Personal";
  if (profileId === "task-disposable") return "Disposable";
  if (profileId === "agent-work") return "Agent";
  return profileId;
}

function bookmarkUrl(bookmark: Pick<BrowserBookmark, "url"> | Pick<BrowserBookmarkToolbarItem, "url">): string {
  return bookmark.url?.trim() ?? "";
}

function compareBookmarksForPanel(a: BrowserBookmark, b: BrowserBookmark): number {
  const orderDelta = (a.toolbarOrder ?? Number.MAX_SAFE_INTEGER) - (b.toolbarOrder ?? Number.MAX_SAFE_INTEGER);
  if (orderDelta !== 0) return orderDelta;
  const labelDelta = a.label.toLocaleLowerCase().localeCompare(b.label.toLocaleLowerCase());
  if (labelDelta !== 0) return labelDelta;
  return a.bookmarkId.localeCompare(b.bookmarkId);
}

function currentPageUrlForSave(state: BrowserState | null, activeTask: BrowserTask | null, activeTab: BrowserTab | null, address: string): string {
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

function pageSaveBaseName(rawUrl: string, title?: string | null): string {
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

function browserLinksFromObservation(observation?: BrowserObservationLike | null): Array<{ label: string; url: string; visible: boolean; refId?: string }> {
  return (observation?.refs ?? [])
    .filter((ref) => ref.role === "link" && typeof ref.value === "string" && ref.value.trim())
    .map((ref) => ({
      label: ref.label || ref.value || "Link",
      url: String(ref.value).trim(),
      visible: ref.visible !== false,
      refId: ref.refId,
    }));
}

function cleanVaultFillText(value?: string | null, fallback = ""): string {
  const cleaned = String(value ?? "").replace(/\s+/g, " ").trim();
  return cleaned || fallback;
}

const VAULT_FILL_EMAIL_PATTERN = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;

function emailAddressesForVaultFill(value?: string | null): string[] {
  const matches = String(value ?? "").toLowerCase().match(VAULT_FILL_EMAIL_PATTERN) ?? [];
  return Array.from(new Set(matches.map((email) => email.trim()).filter(Boolean)));
}

function hostTokensForVaultFill(rawUrl?: string | null): string[] {
  const tokens = new Set<string>();
  const raw = rawUrl?.trim();
  if (!raw) return [];
  try {
    const parsed = new URL(raw.startsWith("about:") || raw.includes("://") ? raw : `https://${raw}`);
    const host = parsed.hostname.toLowerCase();
    for (const part of host.split(".")) {
      if (part.length >= 3 && part !== "www" && /[a-z]/.test(part)) tokens.add(part);
    }
    if (host.includes("google") || host.includes("gmail")) {
      tokens.add("google");
      tokens.add("gmail");
      tokens.add("accounts");
    }
    if (host.includes("microsoft") || host.includes("office") || host.includes("live.com")) {
      tokens.add("microsoft");
      tokens.add("office");
      tokens.add("outlook");
    }
  } catch {
    for (const part of raw.toLowerCase().split(/[^a-z0-9]+/)) {
      if (part.length >= 3) tokens.add(part);
    }
  }
  return [...tokens];
}

function providerTokensForVaultFillText(value?: string | null): string[] {
  const text = String(value ?? "").toLowerCase();
  const tokens = new Set<string>();
  const add = (...next: string[]) => next.forEach((token) => tokens.add(token));
  if (/\b(gmail|google|google accounts?|google sign[- ]?in|google ai studio|gemini)\b/.test(text)) {
    add("google", "gmail", "accounts", "gemini");
  }
  if (/\b(microsoft|office|outlook|live\.com|azure)\b/.test(text)) {
    add("microsoft", "office", "outlook", "azure");
  }
  if (/\b(github|gitlab|notion|slack|stripe|firecrawl|openai|anthropic|claude|cloudflare|linear|figma|airtable|todoist|dropbox|trello|atlassian)\b/.test(text)) {
    for (const token of ["github", "gitlab", "notion", "slack", "stripe", "firecrawl", "openai", "anthropic", "claude", "cloudflare", "linear", "figma", "airtable", "todoist", "dropbox", "trello", "atlassian"]) {
      if (text.includes(token)) tokens.add(token);
    }
  }
  return [...tokens];
}

function pageContextTokensForVaultFill(observation: BrowserObservationLike | null): string[] {
  const tokens = new Set<string>();
  const addFrom = (value?: string | null) => {
    for (const token of providerTokensForVaultFillText(value)) tokens.add(token);
  };
  addFrom(observation?.title);
  addFrom(observation?.text?.slice(0, 12_000));
  addFrom(observation?.markdown?.slice(0, 12_000));
  for (const ref of observation?.refs ?? []) {
    if (ref.visible === false) continue;
    addFrom(ref.label);
    addFrom(ref.name);
    addFrom(ref.selector);
  }
  return [...tokens];
}

function pageEmailsForVaultFill(observation: BrowserObservationLike | null): string[] {
  const emails = new Set<string>();
  for (const email of emailAddressesForVaultFill(`${observation?.title ?? ""} ${observation?.text ?? ""}`)) {
    emails.add(email);
  }
  for (const ref of observation?.refs ?? []) {
    if (ref.visible === false) continue;
    for (const value of [ref.value, ref.label, ref.name]) {
      for (const email of emailAddressesForVaultFill(value)) emails.add(email);
    }
  }
  return [...emails];
}

function browserVaultFillFieldKind(ref: BrowserObservationRefLike): BrowserVaultFillFieldKind | null {
  const metadata = [
    ref.role,
    ref.label,
    ref.name,
    ref.selector,
    ref.refId,
  ].map((value) => String(value ?? "").toLowerCase()).join(" ");
  if (ref.visible === false) return null;
  if (ref.action && ref.action !== "fillRef") return null;
  if (ref.editable === false && ref.role !== "password") return null;
  if (/\b(pass(word)?|passwd)\b/.test(metadata) || ref.role === "password") return "password";
  if (/\b(api[-_ ]?key|apikey|access[-_ ]?key)\b/.test(metadata)) return "apiKey";
  if (/\b(token|bearer|oauth)\b/.test(metadata)) return "token";
  if (/\b(secret|credential)\b/.test(metadata)) return "secret";
  return null;
}

function vaultFillKindScore(kind: BrowserVaultFillFieldKind, haystack: string): number {
  if (kind === "password") {
    return /\b(pass(word)?|passwd|login|credential|account|gmail|google|mail)\b/.test(haystack) ? 8 : 0;
  }
  if (kind === "apiKey") {
    return /\b(api[-_ ]?key|apikey|access[-_ ]?key|developer[-_ ]?key)\b/.test(haystack) ? 8 : 0;
  }
  if (kind === "token") {
    return /\b(token|bearer|oauth|access[-_ ]?token|refresh[-_ ]?token)\b/.test(haystack) ? 8 : 0;
  }
  return /\b(secret|credential)\b/.test(haystack) ? 6 : 0;
}

function vaultFillAccountScore(kind: BrowserVaultFillFieldKind, haystack: string, pageEmails: string[]): number {
  if (kind !== "password") return 0;
  return pageEmails.some((email) => haystack.includes(email)) ? 18 : 0;
}

function vaultFillPasswordFallbackAllowed(haystack: string): boolean {
  return !/\b(api[-_ ]?key|apikey|access[-_ ]?key|developer[-_ ]?key|token|bearer|oauth|webhook|stripe[-_ ]?agent[-_ ]?wallet)\b/.test(haystack);
}

function vaultFillFieldLabel(kind: BrowserVaultFillFieldKind, ref: BrowserObservationRefLike): string {
  return cleanVaultFillText(
    ref.label || ref.name || ref.selector || ref.refId,
    kind === "password" ? "Password field" : kind === "apiKey" ? "API key field" : kind === "token" ? "Token field" : "Secret field",
  );
}

function buildBrowserVaultFillCandidates(input: {
  entries: BrowserVaultKeyMeta[];
  observation: BrowserObservationLike | null;
  url: string;
}): BrowserVaultFillCandidate[] {
  const hostTokens = hostTokensForVaultFill(input.url);
  const contextTokens = Array.from(new Set([...hostTokens, ...pageContextTokensForVaultFill(input.observation)]));
  const pageEmails = pageEmailsForVaultFill(input.observation);
  const refs = (input.observation?.refs ?? [])
    .map((ref) => ({ ref, kind: browserVaultFillFieldKind(ref) }))
    .filter((entry): entry is { ref: BrowserObservationRefLike; kind: BrowserVaultFillFieldKind } => Boolean(entry.kind));
  if (refs.length === 0) return [];

  const candidates: BrowserVaultFillCandidate[] = [];
  const fallbackCandidates: BrowserVaultFillCandidate[] = [];
  for (const entry of input.entries) {
    if ((entry.resourceKind ?? "secret") !== "secret") continue;
    const haystack = [
      entry.key,
      entry.description,
      entry.resourceSummary,
      entry.resourceProvider,
      ...(entry.resourceFields ?? []),
    ].map((value) => String(value ?? "").toLowerCase()).join(" ");
    for (const { ref, kind } of refs) {
      const fieldScore = vaultFillKindScore(kind, haystack);
      const contextTokenScore = contextTokens.reduce((score, token) => score + (haystack.includes(token) ? 5 : 0), 0);
      const accountScore = vaultFillAccountScore(kind, haystack, pageEmails);
      const passwordContextAvailable = kind === "password" && (contextTokens.length > 0 || pageEmails.length > 0);
      const contextScore = contextTokenScore + accountScore;
      const score = fieldScore + contextTokenScore + accountScore;
      const target = ref.refId || ref.selector;
      if (!target) continue;
      if (passwordContextAvailable && contextScore <= 0) {
        continue;
      }
      if (score <= 0) {
        if (kind === "password" && !passwordContextAvailable && vaultFillPasswordFallbackAllowed(haystack)) {
          fallbackCandidates.push({
            id: `${entry.key}:${ref.refId ?? ""}:${ref.selector ?? ""}:fallback`,
            key: entry.key,
            label: entry.key,
            description: cleanVaultFillText(entry.description ?? entry.resourceSummary, entry.userOnly ? "User-only Vault secret" : "Possible Vault password"),
            userOnly: Boolean(entry.userOnly),
            fieldKind: kind,
            fieldLabel: vaultFillFieldLabel(kind, ref),
            refId: ref.refId,
            selector: ref.selector ?? undefined,
            score: 1,
          });
        }
        continue;
      }
      candidates.push({
        id: `${entry.key}:${ref.refId ?? ""}:${ref.selector ?? ""}`,
        key: entry.key,
        label: entry.key,
        description: cleanVaultFillText(entry.description ?? entry.resourceSummary, entry.userOnly ? "User-only Vault secret" : "Vault secret"),
        userOnly: Boolean(entry.userOnly),
        fieldKind: kind,
        fieldLabel: vaultFillFieldLabel(kind, ref),
        refId: ref.refId,
        selector: ref.selector ?? undefined,
        score,
      });
    }
  }
  const bestByTarget = new Map<string, BrowserVaultFillCandidate>();
  for (const candidate of candidates.length > 0 ? candidates : fallbackCandidates) {
    const targetKey = `${candidate.key}:${candidate.refId ?? candidate.selector ?? candidate.fieldKind}`;
    const existing = bestByTarget.get(targetKey);
    if (!existing || candidate.score > existing.score) {
      bestByTarget.set(targetKey, candidate);
    }
  }
  return [...bestByTarget.values()]
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .slice(0, 8);
}

function safeBrowserStatusUrl(rawUrl?: string | null): string {
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

function browserExplainGoal(input: {
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

function browserPageSecurityFromUrl(rawUrl?: string | null): BrowserPageSecurityState {
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

function browserTabShieldsFromUrl(shields: BrowserShieldSettings | undefined, rawUrl?: string | null): BrowserTabShieldState {
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

function browserTrustLabel(security: BrowserPageSecurityState): string {
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

function browserTrustIcon(security: BrowserPageSecurityState): "lock" | "shield-alert" | "alert" {
  if (security.level === "secure") return "lock";
  if (security.level === "insecureHttp") return "shield-alert";
  return "alert";
}

function defaultPersonalLockSettings(): BrowserPersonalLockSettings {
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

function pageSaveReason(kind: BrowserPageSaveKind): string {
  if (kind === "explain") return "userPageAction:explain";
  if (kind === "screenshot") return "userPageSave:screenshot";
  if (kind === "fullPageScreenshot") return "userPageSave:fullPageScreenshot";
  if (kind === "markdown") return "userPageSave:markdown";
  if (kind === "linksJson") return "userPageSave:linksJson";
  if (kind === "snapshotJson") return "userPageSave:snapshotJson";
  if (kind === "media") return "userPageSave:media";
  if (kind === "code") return "userPageSave:code";
  return "userPageSave:workingSiteCopy";
}

function pageSaveDisplayName(kind: BrowserPageSaveKind): string {
  switch (kind) {
    case "explain":
      return "Explain page";
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

function formatReceiptTime(t: number): string {
  if (!Number.isFinite(t) || t <= 0) return "";
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatHistoryTime(t: number): string {
  if (!Number.isFinite(t) || t <= 0) return "";
  return new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatLogLocation(log: BrowserConsoleLog): string {
  const bits = [log.source || "browser-runtime"];
  if (log.url) bits.push(log.url);
  if (Number.isFinite(log.line)) {
    bits.push(`:${log.line}${Number.isFinite(log.column) ? `:${log.column}` : ""}`);
  }
  return bits.join(" ");
}

function browserLogLevelClass(level: string): string {
  const normalized = level.toLowerCase();
  if (normalized === "error") return "error";
  if (normalized === "warn" || normalized === "warning") return "warn";
  return "info";
}

function vaultPromptIcon(prompt: VaultApprovalPrompt): ShellIconName {
  switch (prompt.kind) {
    case "sessionGrant":
      return "lock";
    case "vaultDeposit":
      return "inbox";
    case "credentialFill":
    case "profileFill":
      return "user";
    case "emailCodeRead":
      return "message";
    case "agentWalletUse":
      return "shield-alert";
  }
}

function vaultPromptDebugSuffix(prompt: VaultApprovalPrompt): string {
  return prompt.id.replace(/[^a-z0-9_-]/gi, "-");
}

function vaultPromptEntityId(prompt: VaultApprovalPrompt, prefix: string): string {
  return prompt.id.startsWith(prefix) ? prompt.id.slice(prefix.length) : "";
}

export function ShellxBrowserApp(): JSX.Element {
  const engineSlotRef = useRef<HTMLDivElement | null>(null);
  const bookmarkPointerDragRef = useRef<{ bookmarkId: string; startX: number; startY: number } | null>(null);
  const previousVaultPromptCountRef = useRef<number | null>(null);
  const lastPersonalLockActivitySyncRef = useRef(0);
  const lastPersonalLockTickRef = useRef(Date.now());
  const [address, setAddress] = useState("");
  const [addressEditing, setAddressEditing] = useState(false);
  const [homeUrl, setHomeUrl] = useState(initialHomeUrl);
  const [goal, setGoal] = useState(DEFAULT_GOAL);
  const [profileId, setProfileId] = useState(USER_DEFAULT_PROFILE_ID);
  const [autonomy, setAutonomy] = useState<BrowserAutonomy>("assistedAutonomous");
  const [busy, setBusy] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [headerMenu, setHeaderMenu] = useState<BrowserHeaderMenuId | null>(null);
  const [historyScope, setHistoryScope] = useState<BrowserHistoryScope>("user");
  const [historySearch, setHistorySearch] = useState("");
  const [historyDateFilter, setHistoryDateFilter] = useState<BrowserHistoryDateFilter>("all");
  const [rightPanelTab, setRightPanelTab] = useState<BrowserRightPanelId>("chat");
  const [addressCopied, setAddressCopied] = useState(false);
  const [colorMode, setColorMode] = useState<BrowserColorMode>(initialColorMode);
  const [defaultDownloadFolder, setDefaultDownloadFolder] = useState(initialDownloadFolder);
  const [showRightSidebar, setShowRightSidebar] = useState(true);
  const [rightSidebarWidth, setRightSidebarWidth] = useState(360);
  const [bookmarkManagerOpen, setBookmarkManagerOpen] = useState(false);
  const [bookmarkManageMode, setBookmarkManageMode] = useState(false);
  const [bookmarkDraftLabel, setBookmarkDraftLabel] = useState("");
  const [bookmarkDraftUrl, setBookmarkDraftUrl] = useState("");
  const [bookmarkDraftParentId, setBookmarkDraftParentId] = useState("");
  const [bookmarkDeleteId, setBookmarkDeleteId] = useState<string | null>(null);
  const [bookmarkRenameDrafts, setBookmarkRenameDrafts] = useState<Record<string, string>>({});
  const [bookmarkUrlDrafts, setBookmarkUrlDrafts] = useState<Record<string, string>>({});
  const [openToolbarFolderId, setOpenToolbarFolderId] = useState<string | null>(null);
  const [draggedBookmarkId, setDraggedBookmarkId] = useState<string | null>(null);
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [dismissedVaultDepositIds, setDismissedVaultDepositIds] = useState<Set<string>>(() => new Set());
  const [tabLeases, setTabLeases] = useState<Record<string, { leaseId: string; ownerAgentId: string; ownerRunId: string }>>({});
  const [personalLockPinDraft, setPersonalLockPinDraft] = useState("");
  const [personalLockAttention, setPersonalLockAttention] = useState(false);
  const personalLockAttentionTimerRef = useRef<number | null>(null);
  const lastVaultFillOfferRef = useRef<string | null>(null);
  const [vaultFillEntries, setVaultFillEntries] = useState<BrowserVaultKeyMeta[]>([]);
  const [vaultFillError, setVaultFillError] = useState<string | null>(null);
  const [vaultFillObservation, setVaultFillObservation] = useState<BrowserObservationLike | null>(null);
  const [vaultFillObservationRefresh, setVaultFillObservationRefresh] = useState(0);
  const [collapsedSections, setCollapsedSections] = useState<Record<BrowserSectionId, boolean>>({
    tasks: false,
    console: false,
    receipts: false,
  });
  useEffect(() => {
    return () => {
      if (personalLockAttentionTimerRef.current !== null) {
        window.clearTimeout(personalLockAttentionTimerRef.current);
      }
    };
  }, []);
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
  const handleLiveTabsChanged = useCallback((liveTabs: BrowserTab[]) => {
    setTabLeases((current) => {
      const live = new Set(liveTabs.map((tab) => tab.browserTabId));
      return Object.fromEntries(Object.entries(current).filter(([tabId]) => live.has(tabId)));
    });
  }, []);
  const handleRightPanelPatch = useCallback((tab: BrowserRightPanelPatch) => {
    setRightPanelTab(tab);
  }, []);
  const {
    state,
    refresh,
    error,
    setError,
    debugHighlights,
  } = useBrowserState({
    address,
    profileId,
    onPendingStartUrl: handlePendingStartUrl,
    onMissingProfile: handleMissingProfile,
    onLiveTabsChanged: handleLiveTabsChanged,
    onRightPanelPatch: handleRightPanelPatch,
    onDebugClick: runBrowserDebugClickSelector,
    onDebugInput: runBrowserDebugInputSelector,
    onDebugDrag: runBrowserDebugDragSelector,
  });

  const activeTask = useMemo(() => {
    if (!state?.activeTaskId) return null;
    return state.tasks.find((task) => task.taskId === state.activeTaskId) ?? null;
  }, [state]);

  const tabs = state?.tabs ?? [];
  const activeBrowserTab = useMemo(() => {
    if (!state?.activeBrowserTabId) return tabs.find((tab) => tab.active) ?? null;
    return tabs.find((tab) => tab.browserTabId === state.activeBrowserTabId) ?? null;
  }, [state?.activeBrowserTabId, tabs]);
  const activeTaskForActiveTab = activeBrowserTab?.taskId === activeTask?.taskId ? activeTask : null;
  const manualVaultFillAllowed = (activeBrowserTab?.ownerKind ?? "user") === "user";
  const personalLock = state?.personalLock ?? defaultPersonalLockSettings();
  const personalTabLocked =
    personalLock.enabled && personalLock.locked && activeBrowserTab?.profileId === USER_DEFAULT_PROFILE_ID;
  const canHandOffActiveTab =
    Boolean(activeBrowserTab && activeTask && activeBrowserTab.ownerKind !== "delegatedToAgent" && activeBrowserTab.ownerKind !== "agent");
  const canTakeBackActiveTab = activeBrowserTab?.ownerKind === "delegatedToAgent";
  const headerProfileId = activeBrowserTab?.profileId ?? profileId;
  const headerProfile = useMemo(() => {
    return (state?.profiles ?? []).find((profile) => profile.profileId === headerProfileId) ?? null;
  }, [headerProfileId, state?.profiles]);
  const activeTabLease = activeBrowserTab ? tabLeases[activeBrowserTab.browserTabId] ?? null : null;
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
  const vaultFillCandidates = useMemo(
    () => manualVaultFillAllowed
      ? buildBrowserVaultFillCandidates({
          entries: vaultFillEntries,
          observation: vaultFillObservation,
          url: currentPageUrlForSave(state, activeTask, activeBrowserTab, address),
        })
      : [],
    [activeBrowserTab, activeTask, address, manualVaultFillAllowed, state, vaultFillEntries, vaultFillObservation],
  );
  const vaultFillDetectedFieldCount = useMemo(
    () => (vaultFillObservation?.refs ?? []).filter((ref) => Boolean(browserVaultFillFieldKind(ref))).length,
    [vaultFillObservation],
  );
  const bookmarks = state?.bookmarks ?? [];
  const bookmarkToolbar = state?.bookmarkToolbar ?? [];
  const openToolbarFolder = useMemo(
    () => bookmarkToolbar.find((item) => item.kind === "folder" && item.bookmarkId === openToolbarFolderId) ?? null,
    [bookmarkToolbar, openToolbarFolderId],
  );
  const historyEntries = state?.history ?? [];
  const enginePool = state?.enginePool ?? null;
  const bookmarkFolders = useMemo(() => bookmarks.filter((bookmark) => bookmark.kind === "folder"), [bookmarks]);
  const rootBookmarks = useMemo(
    () => bookmarks.filter((bookmark) => !bookmark.parentId).slice().sort(compareBookmarksForPanel),
    [bookmarks],
  );
  const bookmarkChildrenByParent = useMemo(() => {
    const next = new Map<string, BrowserBookmark[]>();
    for (const bookmark of bookmarks) {
      if (!bookmark.parentId) continue;
      const children = next.get(bookmark.parentId) ?? [];
      children.push(bookmark);
      next.set(bookmark.parentId, children);
    }
    for (const children of next.values()) children.sort(compareBookmarksForPanel);
    return next;
  }, [bookmarks]);
  const userHistory = useMemo(() => historyEntries.filter((entry) => entry.profileId === "personal" && !entry.taskId), [historyEntries]);
  const agentHistory = useMemo(() => historyEntries.filter((entry) => entry.profileId !== "personal" || Boolean(entry.taskId)), [historyEntries]);
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
  const displayedAutonomy = activeTask?.autonomy ?? autonomy;
  const selectedAdMode = useMemo<BrowserVisibleAdMode>(() => {
    const privacy = state?.privacy;
    if (!privacy) return "balanced";
    return browserVisibleAdMode(
      privacy.profileModes?.find((mode) => mode.profileId === headerProfileId)?.adMode ?? privacy.globalAdMode,
    );
  }, [headerProfileId, state?.privacy]);
  const browserChatMessages = useMemo(() => {
    const messages: Array<{ id: string; role: "system" | "user" | "assistant"; label: string; text: string }> = [];
    if (activeTask) {
      messages.push({
        id: `${activeTask.taskId}-user`,
        role: "user",
        label: "You",
        text: activeTask.goal,
      });
      const currentUrl = safeBrowserStatusUrl(activeTask.currentUrl ?? state?.engine?.url ?? activeBrowserTab?.url ?? address.trim());
      messages.push({
        id: `${activeTask.taskId}-assistant`,
        role: "assistant",
        label: "Agent",
        text: `Task is ${activeTask.status.toLowerCase()}. ${currentUrl ? `Current page: ${currentUrl}. ` : ""}Engine: ${state?.engine?.loadStatus ?? "starting"}.`,
      });
      return messages;
    }
    messages.push({
      id: "browser-ready",
      role: "system",
      label: "Agent",
      text: "Ask the agent to use the current page or open a disposable tab for an isolated task.",
    });
    return messages;
  }, [activeBrowserTab?.url, activeTask, address, state?.engine?.loadStatus, state?.engine?.url]);

  useEffect(() => {
    window.localStorage.setItem(COLOR_MODE_STORAGE_KEY, colorMode);
  }, [colorMode]);

  useEffect(() => {
    window.localStorage.setItem(HOME_URL_STORAGE_KEY, homeUrl.trim() || DEFAULT_HOME_URL);
  }, [homeUrl]);

  useEffect(() => {
    persistBrowserDownloadFolder(defaultDownloadFolder);
    void updateBrowserDownloadFolder(defaultDownloadFolder).then(() => refresh()).catch(() => undefined);
  }, [defaultDownloadFolder]);

  useEffect(() => {
    if (!personalLock.enabled) return;
    const recordTrustedActivity = () => {
      if (personalLock.locked) return;
      const now = Date.now();
      if (now - lastPersonalLockActivitySyncRef.current < 30_000) return;
      lastPersonalLockActivitySyncRef.current = now;
      void updateBrowserPersonalLock({
        action: "trustedActivity",
        trustedUserActivity: true,
      }).then(() => refresh()).catch(() => undefined);
    };
    window.addEventListener("pointerdown", recordTrustedActivity, true);
    window.addEventListener("keydown", recordTrustedActivity, true);
    return () => {
      window.removeEventListener("pointerdown", recordTrustedActivity, true);
      window.removeEventListener("keydown", recordTrustedActivity, true);
    };
  }, [personalLock.enabled, personalLock.locked, refresh]);

  useEffect(() => {
    if (!personalLock.enabled) return;
    const timer = window.setInterval(() => {
      void updateBrowserPersonalLock({}).then(() => refresh()).catch(() => undefined);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [personalLock.enabled, refresh]);

  useEffect(() => {
    lastPersonalLockTickRef.current = Date.now();
    if (!personalLock.enabled || personalLock.locked || !personalLock.lockOnSleep) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      const driftMs = now - lastPersonalLockTickRef.current;
      lastPersonalLockTickRef.current = now;
      if (driftMs < 120_000) return;
      void updateBrowserPersonalLock({ action: "lockNow" }).then(() => refresh()).catch(() => undefined);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [personalLock.enabled, personalLock.lockOnSleep, personalLock.locked, refresh]);

  useEffect(() => {
    if (!inTauri() || !personalLock.enabled || personalLock.locked || !personalLock.lockOnMinimize) return;
    let cancelled = false;
    const checkMinimized = async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const minimized = await getCurrentWindow().isMinimized();
        if (cancelled || !minimized) return;
        await updateBrowserPersonalLock({ action: "lockNow" });
        await refresh();
      } catch {
        // Minimize state is best-effort; timeout and manual lock remain authoritative.
      }
    };
    const timer = window.setInterval(() => {
      void checkMinimized();
    }, 2_000);
    void checkMinimized();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [personalLock.enabled, personalLock.lockOnMinimize, personalLock.locked, refresh]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== "shellX.settings.v2") return;
      const folder = readSettingsLocal().browserDownloadFolder;
      setDefaultDownloadFolder((current) => current === folder ? current : folder);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (addressEditing) return;
    setAddress(addressSourceUrl);
  }, [addressSourceUrl, addressEditing]);

  useEffect(() => {
    if (!inTauri()) return;
    let cancelled = false;
    const refreshVaultFillEntries = () => {
      void listBrowserVaultKeys()
        .then((entries) => {
          if (cancelled) return;
          setVaultFillEntries(entries);
          setVaultFillError(null);
        })
        .catch((err) => {
          if (cancelled) return;
          setVaultFillEntries([]);
          const message = err instanceof Error ? err.message : String(err);
          setVaultFillError(message || "Vault is locked or unavailable.");
        });
    };
    refreshVaultFillEntries();
    const timer = window.setInterval(refreshVaultFillEntries, 8_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    activeBrowserTab?.browserTabId,
    activeBrowserTab?.url,
    manualVaultFillAllowed,
    state?.engine?.url,
    vaultDeposits.length,
    vaultFillObservationRefresh,
  ]);

  useEffect(() => {
    let cancelled = false;
    setVaultFillObservation(null);
    if (!activeBrowserTab || personalTabLocked || !manualVaultFillAllowed) return () => {
      cancelled = true;
    };
    const rawUrl = state?.engine?.url ?? activeBrowserTab.url ?? "";
    if (!rawUrl.trim() || rawUrl.startsWith("about:")) return () => {
      cancelled = true;
    };
    const timer = window.setTimeout(() => {
      void browserApiPostJson<BrowserActionResponseLike>("/browser/action", {
        browserTabId: activeBrowserTab.browserTabId,
        action: "observe",
      })
        .then((response) => {
          if (!cancelled) setVaultFillObservation(response.observation ?? null);
        })
        .catch(() => {
          if (!cancelled) setVaultFillObservation(null);
        });
    }, 450);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeBrowserTab?.browserTabId, activeBrowserTab?.url, manualVaultFillAllowed, personalTabLocked, state?.engine?.loadStatus, state?.engine?.url, vaultFillObservationRefresh]);

  useEffect(() => {
    const hasFillSurface =
      vaultFillCandidates.length > 0 || (Boolean(vaultFillError) && vaultFillDetectedFieldCount > 0);
    if (!hasFillSurface || personalTabLocked || optionsOpen || addressEditing || headerMenu !== null) return;
    const signature = [
      activeBrowserTab?.browserTabId ?? "no-tab",
      currentPageUrlForSave(state, activeTask, activeBrowserTab, address),
      vaultFillError ?? "",
      vaultFillCandidates.map((candidate) => candidate.id).join("|"),
    ].join("::");
    if (lastVaultFillOfferRef.current === signature) return;
    lastVaultFillOfferRef.current = signature;
    setHeaderMenu("vaultFill");
  }, [
    activeBrowserTab,
    activeTask,
    address,
    addressEditing,
    headerMenu,
    optionsOpen,
    personalTabLocked,
    state,
    vaultFillCandidates,
    vaultFillDetectedFieldCount,
    vaultFillError,
  ]);

  useEffect(() => {
    const closeFloatingMenus = (event: globalThis.PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest(".shellx-browser-bookmark-toolbar, .shellx-browser-bookmark-folder-menu-dock")) {
        setOpenToolbarFolderId(null);
      }
      if (target?.closest(".shellx-browser-shields-wrap, .shellx-browser-header-menu-wrap, .shellx-browser-options-wrap, .shellx-browser-chrome-menu-dock, .shellx-browser-left-sidecar")) return;
      setHeaderMenu(null);
      setOptionsOpen(false);
    };
    const closeWithEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setHeaderMenu(null);
      setOptionsOpen(false);
      setOpenToolbarFolderId(null);
    };
    window.addEventListener("pointerdown", closeFloatingMenus);
    window.addEventListener("keydown", closeWithEscape);
    return () => {
      window.removeEventListener("pointerdown", closeFloatingMenus);
      window.removeEventListener("keydown", closeWithEscape);
    };
  }, []);

  useEffect(() => {
    const taskId = activeTask?.taskId;
    const recordUiError = (message: string, details: Record<string, unknown>) => {
      void browserApiPostJson("/browser/logs", {
        taskId,
        level: "error",
        source: "shellx-browser-ui",
        message,
        details,
      }).catch(() => undefined);
    };
    const onError = (event: ErrorEvent) => {
      recordUiError(event.message || "Browser UI script error", {
        filename: event.filename,
        line: event.lineno,
        column: event.colno,
      });
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      recordUiError(event.reason instanceof Error ? event.reason.message : String(event.reason), {
        reason: event.reason instanceof Error ? event.reason.stack : String(event.reason),
      });
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, [activeTask?.taskId]);

  useNativeEngineSync({
    enabled: inTauri() && tabs.length > 0,
    slotRef: engineSlotRef,
    activeEngineId: activeBrowserTab?.engineId ?? null,
    activeBrowserTabId: activeBrowserTab?.browserTabId ?? null,
    profileId: engineProfileId,
    url: engineUrl || null,
    dependencies: [
      bookmarkManageMode,
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

  function isPersonalLockPolicyMessage(message: string): boolean {
    return message.toLowerCase().includes("personal browser is locked");
  }

  function focusPersonalLockToggle(): void {
    setPersonalLockAttention(true);
    if (personalLockAttentionTimerRef.current !== null) {
      window.clearTimeout(personalLockAttentionTimerRef.current);
    }
    personalLockAttentionTimerRef.current = window.setTimeout(() => {
      setPersonalLockAttention(false);
      personalLockAttentionTimerRef.current = null;
    }, 3600);
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>("[data-debug-id='shellx-browser-personal-lock-toggle']")?.focus();
    });
  }

  function showPersonalLockBlockedNotice(): void {
    setHeaderMenu(null);
    setOptionsOpen(false);
    setOpenToolbarFolderId(null);
    setError("Personal Browser Lock is on. Unlock personal tabs before opening or using personal pages.");
    focusPersonalLockToggle();
  }

  async function withBusy(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isPersonalLockPolicyMessage(message)) {
        showPersonalLockBlockedNotice();
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  const handleVaultFillCandidate = (
    candidate: BrowserVaultFillCandidate,
    event: ShellxUserEventLike,
  ) => {
    if (!isTrustedShellxUserEvent(event)) {
      setError("Vault fill requires a direct user click.");
      return;
    }
    if (!activeBrowserTab) return;
    void withBusy(async () => {
      const response = await fillUserVaultSecret({
        browserTabId: activeBrowserTab.browserTabId,
        secretRef: candidate.key,
        refId: candidate.refId,
        selector: candidate.selector,
      }) as BrowserActionResponseLike;
      if (response?.ok === false || response?.status === "blocked") {
        throw new Error(response.message || "Vault fill was blocked.");
      }
      setHeaderMenu(null);
      setVaultFillObservation(null);
      setVaultFillObservationRefresh((current) => current + 1);
    });
  };

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

  const browserActionContext = () => ({
    ...(activeBrowserTab ? { browserTabId: activeBrowserTab.browserTabId } : {}),
    ...(activeTabLease
      ? {
          lockLeaseId: activeTabLease.leaseId,
          ownerAgentId: activeTabLease.ownerAgentId,
          ownerRunId: activeTabLease.ownerRunId,
        }
      : {}),
  });

  const navigateToUrl = (rawUrl: string) => {
    const url = rawUrl.trim();
    if (!url) return;
    setHeaderMenu(null);
    setOptionsOpen(false);
    setOpenToolbarFolderId(null);
    setAddress(url);
    void withBusy(async () => {
      if (activeTaskForActiveTab) {
        await browserApiPostJson("/browser/action", {
          ...browserActionContext(),
          taskId: activeTaskForActiveTab.taskId,
          action: "navigate",
          url,
        });
      } else if (activeBrowserTab) {
        await browserApiPostJson("/browser/action", {
          ...browserActionContext(),
          action: "navigate",
          url,
        });
      } else {
        if (personalLock.enabled && personalLock.locked) {
          showPersonalLockBlockedNotice();
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
      await browserApiPostJson("/browser/action", {
        ...browserActionContext(),
        ...(activeTaskForActiveTab ? { taskId: activeTaskForActiveTab.taskId } : {}),
        action,
      });
    });
  };

  const bookmarkCurrent = () => {
    void withBusy(async () => {
      await browserApiPostJson("/browser/action", {
        ...browserActionContext(),
        ...(activeTask ? { taskId: activeTask.taskId } : {}),
        action: "bookmarkCurrent",
        url: currentPageUrlForSave(state, activeTask, activeBrowserTab, address),
        value: state?.engine?.title ?? activeTask?.currentUrl ?? activeBrowserTab?.url ?? address.trim(),
      });
    });
  };

  const nextBookmarkOrder = (parentId: string | null) => bookmarks
    .filter((bookmark) => (bookmark.parentId ?? null) === parentId)
    .length;

  const createBookmarkFolder = () => {
    const label = bookmarkDraftLabel.trim() || "New folder";
    const parentId = bookmarkDraftParentId || null;
    void withBusy(async () => {
      await browserApiPostJson("/browser/bookmarks", {
        label,
        kind: "folder",
        parentId,
        toolbarPinned: false,
        toolbarOrder: nextBookmarkOrder(parentId),
      });
      setBookmarkDraftLabel("");
      setBookmarkDeleteId(null);
    });
  };

  const createBookmarkLink = () => {
    const label = bookmarkDraftLabel.trim();
    const url = bookmarkDraftUrl.trim();
    if (!url) {
      setError("Bookmark link needs a URL.");
      return;
    }
    void withBusy(async () => {
      await browserApiPostJson("/browser/bookmarks", {
        label: label || url,
        kind: "link",
        url,
        parentId: bookmarkDraftParentId || null,
        toolbarPinned: false,
        toolbarOrder: nextBookmarkOrder(bookmarkDraftParentId || null),
      });
      setBookmarkDraftLabel("");
      setBookmarkDraftUrl("");
      setBookmarkDraftParentId("");
      setBookmarkDeleteId(null);
    });
  };

  const updateBookmarkRenameDraft = (bookmarkId: string, label: string) => {
    setBookmarkRenameDrafts((current) => ({ ...current, [bookmarkId]: label }));
  };

  const updateBookmarkUrlDraft = (bookmarkId: string, url: string) => {
    setBookmarkUrlDrafts((current) => ({ ...current, [bookmarkId]: url }));
  };

  const resetBookmarkRenameDraft = (bookmarkId: string) => {
    setBookmarkRenameDrafts((current) => {
      const next = { ...current };
      delete next[bookmarkId];
      return next;
    });
  };

  const resetBookmarkUrlDraft = (bookmarkId: string) => {
    setBookmarkUrlDrafts((current) => {
      const next = { ...current };
      delete next[bookmarkId];
      return next;
    });
  };

  const commitBookmarkRename = (bookmark: BrowserBookmark, nextLabel?: string) => {
    const label = (nextLabel ?? bookmarkRenameDrafts[bookmark.bookmarkId] ?? bookmark.label).trim();
    if (!label || label === bookmark.label) {
      setBookmarkRenameDrafts((current) => {
        const next = { ...current };
        delete next[bookmark.bookmarkId];
        return next;
      });
      return;
    }
    void withBusy(async () => {
      await browserApiPostJson("/browser/bookmarks", {
        bookmarkId: bookmark.bookmarkId,
        label,
        kind: bookmark.kind,
        url: bookmark.url ?? null,
        category: bookmark.category,
        toolbarPinned: bookmark.toolbarPinned,
        toolbarOrder: bookmark.toolbarOrder ?? null,
      });
      setBookmarkDeleteId(null);
      setBookmarkRenameDrafts((current) => {
        const next = { ...current };
        delete next[bookmark.bookmarkId];
        return next;
      });
    });
  };

  const commitBookmarkUrl = (bookmark: BrowserBookmark, nextUrl?: string) => {
    if (bookmark.kind !== "link") return;
    const currentUrl = bookmarkUrl(bookmark);
    const url = (nextUrl ?? bookmarkUrlDrafts[bookmark.bookmarkId] ?? currentUrl).trim();
    if (!url) {
      setError("Bookmark link needs a URL.");
      setBookmarkUrlDrafts((current) => {
        const next = { ...current };
        delete next[bookmark.bookmarkId];
        return next;
      });
      return;
    }
    if (url === currentUrl) {
      setBookmarkUrlDrafts((current) => {
        const next = { ...current };
        delete next[bookmark.bookmarkId];
        return next;
      });
      return;
    }
    void withBusy(async () => {
      await browserApiPostJson("/browser/bookmarks", {
        bookmarkId: bookmark.bookmarkId,
        label: bookmark.label,
        kind: "link",
        url,
        category: bookmark.category,
        toolbarPinned: bookmark.toolbarPinned,
        toolbarOrder: bookmark.toolbarOrder ?? null,
      });
      setBookmarkDeleteId(null);
      setBookmarkUrlDrafts((current) => {
        const next = { ...current };
        delete next[bookmark.bookmarkId];
        return next;
      });
    });
  };

  const toggleBookmarkPin = (bookmark: BrowserBookmark) => {
    void withBusy(async () => {
      await browserApiPostJson("/browser/bookmarks/reorder", {
        items: [
          {
            bookmarkId: bookmark.bookmarkId,
            parentId: bookmark.parentId ?? null,
            toolbarPinned: !bookmark.toolbarPinned,
            toolbarOrder: bookmark.toolbarPinned ? null : bookmarkToolbar.length,
          },
        ],
      });
      setBookmarkDeleteId(null);
    });
  };

  const reorderBookmarkIntoParent = (bookmarkId: string, parentId: string | null, beforeBookmarkId?: string | null) => {
    if (!bookmarkId || bookmarkId === beforeBookmarkId) return;
    const source = bookmarks.find((bookmark) => bookmark.bookmarkId === bookmarkId);
    if (!source) return;
    if (parentId === source.bookmarkId) return;
    const parentKey = parentId ?? "";
    const siblings = bookmarks
      .filter((bookmark) => (bookmark.parentId ?? "") === parentKey && bookmark.bookmarkId !== bookmarkId)
      .slice()
      .sort(compareBookmarksForPanel);
    const targetIndex = beforeBookmarkId ? siblings.findIndex((bookmark) => bookmark.bookmarkId === beforeBookmarkId) : -1;
    const insertAt = targetIndex >= 0 ? targetIndex : siblings.length;
    const ordered = siblings.slice();
    ordered.splice(insertAt < 0 ? ordered.length : insertAt, 0, { ...source, parentId });
    void withBusy(async () => {
      await browserApiPostJson("/browser/bookmarks/reorder", {
        items: ordered.map((bookmark, index) => ({
          bookmarkId: bookmark.bookmarkId,
          parentId,
          toolbarPinned: parentId ? false : bookmark.toolbarPinned,
          toolbarOrder: index,
        })),
      });
      setBookmarkDeleteId(null);
      setDraggedBookmarkId(null);
    });
  };

  const dropBookmarkBefore = (event: DragEvent<HTMLElement>, target: BrowserBookmark) => {
    event.preventDefault();
    const bookmarkId = draggedBookmarkId || event.dataTransfer.getData("text/plain");
    if (!bookmarkId) return;
    reorderBookmarkIntoParent(bookmarkId, target.parentId ?? null, target.bookmarkId);
  };

  const dropBookmarkIntoFolder = (event: DragEvent<HTMLElement>, folder: BrowserBookmark) => {
    event.preventDefault();
    event.stopPropagation();
    const bookmarkId = draggedBookmarkId || event.dataTransfer.getData("text/plain");
    if (!bookmarkId || bookmarkId === folder.bookmarkId) return;
    reorderBookmarkIntoParent(bookmarkId, folder.bookmarkId, null);
  };

  const finishBookmarkPointerDrag = (event: globalThis.PointerEvent) => {
    const drag = bookmarkPointerDragRef.current;
    bookmarkPointerDragRef.current = null;
    if (!drag) return;
    window.removeEventListener("pointerup", finishBookmarkPointerDrag);
    window.removeEventListener("pointercancel", cancelBookmarkPointerDrag);
    const moved = Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY);
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const folderTarget = target?.closest("[data-bookmark-folder-target-id]") as HTMLElement | null;
    if (folderTarget) {
      const parentId = folderTarget.dataset.bookmarkFolderTargetId || null;
      if (parentId !== drag.bookmarkId) {
        reorderBookmarkIntoParent(drag.bookmarkId, parentId, null);
        return;
      }
    }
    const rowTarget = target?.closest("[data-bookmark-row-id]") as HTMLElement | null;
    const targetBookmarkId = rowTarget?.dataset.bookmarkRowId ?? null;
    if (moved > 4 && targetBookmarkId && targetBookmarkId !== drag.bookmarkId) {
      const targetBookmark = bookmarks.find((bookmark) => bookmark.bookmarkId === targetBookmarkId);
      if (targetBookmark) {
        reorderBookmarkIntoParent(drag.bookmarkId, targetBookmark.parentId ?? null, targetBookmark.bookmarkId);
        return;
      }
    }
    setDraggedBookmarkId(null);
  };

  function cancelBookmarkPointerDrag() {
    bookmarkPointerDragRef.current = null;
    window.removeEventListener("pointerup", finishBookmarkPointerDrag);
    window.removeEventListener("pointercancel", cancelBookmarkPointerDrag);
    setDraggedBookmarkId(null);
  }

  const openBookmark = (bookmark: BrowserBookmark) => {
    const url = bookmarkUrl(bookmark);
    if (!url) return;
    setBookmarkManagerOpen(false);
    void navigateToUrl(url);
  };

  const toggleBookmarksPanel = () => {
    const nextOpen = !bookmarkManagerOpen;
    setHeaderMenu(null);
    setOptionsOpen(false);
    setOpenToolbarFolderId(null);
    setBookmarkManagerOpen(nextOpen);
    if (nextOpen) setBookmarkManageMode(false);
  };

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
    void withBusy(async () => {
      await browserApiPostJson("/browser/tabs/reorder", { browserTabIds: nextIds });
      setDraggedTabId(null);
    });
  };

  const deleteBookmark = (bookmark: BrowserBookmark) => {
    if (bookmarkDeleteId !== bookmark.bookmarkId) {
      setBookmarkDeleteId(bookmark.bookmarkId);
      return;
    }
    void withBusy(async () => {
      await browserApiDeleteJson(`/browser/bookmarks/${encodeURIComponent(bookmark.bookmarkId)}`);
      setBookmarkDeleteId(null);
    });
  };

  const copyAddress = () => {
    const value = currentPageUrlForSave(state, activeTask, activeBrowserTab, address);
    if (!value) return;
    void navigator.clipboard.writeText(value).then(
      () => {
        setAddressCopied(true);
        window.setTimeout(() => setAddressCopied(false), 1200);
      },
      (err) => setError(err instanceof Error ? err.message : String(err)),
    );
  };

  const completeLocalDownload = async (input: {
    kind: BrowserPageSaveKind;
    url: string;
    fileName: string;
    finalPath: string;
    mimeType?: string | null;
    bytes: number;
    sha256: string;
  }): Promise<void> => {
    const transfer = await browserApiPostJson<BrowserTransferEntry>("/browser/downloads/request", {
      ...(activeTaskForActiveTab ? { taskId: activeTaskForActiveTab.taskId } : {}),
      ...(activeBrowserTab ? { browserTabId: activeBrowserTab.browserTabId } : {}),
      ...(defaultDownloadFolder.trim() ? { destinationDir: defaultDownloadFolder.trim() } : {}),
      url: input.url,
      fileName: input.fileName,
      reason: pageSaveReason(input.kind),
    });
    const approval = await grantBrowserTransfer({
      transferId: transfer.transferId,
      direction: "download",
      origin: input.url,
      sha256: input.sha256,
      ttlSeconds: 300,
    });
    await browserApiPostJson<BrowserTransferEntry>("/browser/downloads/complete", {
      transferId: transfer.transferId,
      finalPath: input.finalPath,
      mimeType: input.mimeType,
      bytes: input.bytes,
      sha256: input.sha256,
      sourceUrl: input.url,
      destination: "local-downloads",
      retentionReason: pageSaveReason(input.kind),
      approvalId: approval.approvalId,
    });
  };

  const writeLocalTextDownload = async (input: {
    kind: BrowserPageSaveKind;
    url: string;
    fileName: string;
    content: string;
    mimeType: string;
  }): Promise<void> => {
    const artifact = await writeBrowserTextArtifact({
      destinationDir: defaultDownloadFolder.trim() || undefined,
      fileName: input.fileName,
      content: input.content,
    });
    await completeLocalDownload({
      kind: input.kind,
      url: input.url,
      fileName: artifact.displayName || input.fileName,
      finalPath: artifact.finalPath,
      mimeType: artifact.mimeType || input.mimeType,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    });
  };

  const copyLocalFileDownload = async (input: {
    kind: BrowserPageSaveKind;
    url: string;
    fileName: string;
    sourcePath: string;
    mimeType: string;
  }): Promise<void> => {
    const artifact = await copyBrowserLocalArtifact({
      sourcePath: input.sourcePath,
      destinationDir: defaultDownloadFolder.trim() || undefined,
      fileName: input.fileName,
    });
    await completeLocalDownload({
      kind: input.kind,
      url: input.url,
      fileName: artifact.displayName || input.fileName,
      finalPath: artifact.finalPath,
      mimeType: artifact.mimeType || input.mimeType,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    });
  };

  const captureScreenshotForSave = async (kind: "screenshot" | "fullPageScreenshot", url: string, title?: string | null): Promise<BrowserScreenshotLike> => {
    const fullPage = kind === "fullPageScreenshot";
    const response = await browserApiPostJson<BrowserActionResponseLike>("/browser/action", {
      ...browserActionContext(),
      ...(activeTaskForActiveTab ? { taskId: activeTaskForActiveTab.taskId } : {}),
      action: "captureScreenshot",
      fullPage,
    });
    const screenshot = response.screenshot;
    if (!screenshot?.path) {
      throw new Error(response.message || "Browser screenshot did not produce an artifact.");
    }
    const fileName = `${pageSaveBaseName(url, title || screenshot.title)}${fullPage ? "-fullpage" : "-window"}.png`;
    await copyLocalFileDownload({
      kind,
      url,
      fileName,
      sourcePath: screenshot.path,
      mimeType: "image/png",
    });
    return screenshot;
  };

  const extractObservationForSave = async (): Promise<BrowserObservationLike> => {
    const response = await browserApiPostJson<BrowserActionResponseLike>("/browser/action", {
      ...browserActionContext(),
      ...(activeTaskForActiveTab ? { taskId: activeTaskForActiveTab.taskId } : {}),
      action: "extractMarkdown",
    });
    const observation = response.observation;
    if (!observation) {
      throw new Error(response.message || "Browser extraction did not return page content.");
    }
    return observation;
  };

  const requestImmediatePageSave = async (kind: BrowserImmediateSaveKind, url: string): Promise<void> => {
    const title = state?.engine?.title ?? activeBrowserTab?.title ?? activeTaskForActiveTab?.currentUrl ?? url;
    if (kind === "screenshot" || kind === "fullPageScreenshot") {
      await captureScreenshotForSave(kind, url, title);
      return;
    }

    const observation = await extractObservationForSave();
    const base = pageSaveBaseName(url, observation.title || title);
    if (kind === "markdown") {
      const markdown = observation.markdown || observation.text || "";
      if (!markdown.trim()) throw new Error("Browser extraction returned empty Markdown.");
      await writeLocalTextDownload({
        kind,
        url,
        fileName: `${base}.md`,
        content: markdown,
        mimeType: "text/markdown",
      });
      return;
    }

    const links = browserLinksFromObservation(observation);
    if (kind === "linksJson") {
      await writeLocalTextDownload({
        kind,
        url,
        fileName: `${base}-links.json`,
        content: JSON.stringify({
          sourceUrl: observation.url || url,
          title: observation.title || title,
          capturedAt: new Date().toISOString(),
          count: links.length,
          links,
        }, null, 2),
        mimeType: "application/json",
      });
      return;
    }

    const screenshot = await captureScreenshotForSave("fullPageScreenshot", url, observation.title || title);
    await writeLocalTextDownload({
      kind,
      url,
      fileName: `${base}-snapshot.json`,
      content: JSON.stringify({
        sourceUrl: observation.url || url,
        title: observation.title || title,
        capturedAt: new Date().toISOString(),
        domSummary: observation.domSummary ?? null,
        markdown: observation.markdown || observation.text || "",
        links,
        screenshot: {
          path: screenshot.path,
          bytes: screenshot.bytes,
          sha256: screenshot.sha256,
          width: screenshot.width ?? null,
          height: screenshot.height ?? null,
          fullPage: screenshot.fullPage === true,
          pageWidth: screenshot.pageWidth ?? null,
          pageHeight: screenshot.pageHeight ?? null,
        },
      }, null, 2),
      mimeType: "application/json",
    });
  };

  const requestQueuedPageSave = async (kind: BrowserPageSaveKind, url: string): Promise<void> => {
    await browserApiPostJson("/browser/downloads/request", {
      ...(activeTaskForActiveTab ? { taskId: activeTaskForActiveTab.taskId } : {}),
      ...(activeBrowserTab ? { browserTabId: activeBrowserTab.browserTabId } : {}),
      ...(defaultDownloadFolder.trim() ? { destinationDir: defaultDownloadFolder.trim() } : {}),
      url,
      fileName: pageSaveDisplayName(kind),
      reason: pageSaveReason(kind),
    });
  };

  const startBrowserTaskWithGoal = async (taskGoal: string, startUrl?: string | null): Promise<void> => {
    const cleanGoal = taskGoal.trim();
    if (!cleanGoal) return;
    const taskProfileId = profileId === USER_DEFAULT_PROFILE_ID ? AGENT_DEFAULT_PROFILE_ID : profileId;
    await browserApiPostJson("/browser/task/start", {
      goal: cleanGoal,
      startUrl: startUrl?.trim() || undefined,
      profileId: taskProfileId,
      autonomy,
    });
    setProfileId(taskProfileId);
  };

  const requestExplainPage = async (url: string): Promise<void> => {
    let observation: BrowserObservationLike | null = null;
    try {
      observation = await extractObservationForSave();
    } catch {
      observation = null;
    }
    const safeStartUrl = safeBrowserStatusUrl(observation?.url || url);
    const taskGoal = browserExplainGoal({
      url,
      title: state?.engine?.title ?? activeBrowserTab?.title ?? null,
      observation,
    });
    await startBrowserTaskWithGoal(taskGoal, safeStartUrl.startsWith("about:") ? null : safeStartUrl || null);
  };

  const requestPageSave = (kind: BrowserPageSaveKind, event: MouseEvent<HTMLButtonElement>) => {
    if (!isTrustedShellxUserEvent(event)) {
      return;
    }
    const url = currentPageUrlForSave(state, activeTask, activeBrowserTab, address);
    if (!url) {
      setError("Open a page before saving Browser content.");
      return;
    }
    setHeaderMenu(null);
    void withBusy(async () => {
      if (kind === "explain") {
        await requestExplainPage(url);
      } else if (kind === "screenshot" || kind === "fullPageScreenshot" || kind === "markdown" || kind === "linksJson" || kind === "snapshotJson") {
        await requestImmediatePageSave(kind, url);
      } else {
        await requestQueuedPageSave(kind, url);
      }
      setBookmarkManagerOpen(false);
      setOptionsOpen(false);
      setOpenToolbarFolderId(null);
      if (kind === "explain") {
        setShowRightSidebar(true);
        setRightPanelTab("chat");
      } else {
        setHeaderMenu("downloads");
        setRightPanelTab("actions");
      }
    });
  };

  const chooseDefaultDownloadFolder = () => {
    if (!inTauri()) {
      setError("Folder picker is available in the ShellX desktop app.");
      return;
    }
    void withBusy(async () => {
      const selected = await openDialog({ directory: true, multiple: false });
      const value = Array.isArray(selected) ? selected[0] : selected;
      if (typeof value === "string" && value.trim()) {
        setDefaultDownloadFolder(value);
      }
    });
  };

  const setTaskAutonomy = (nextAutonomy: BrowserAutonomy) => {
    setAutonomy(nextAutonomy);
    if (!activeTask) return;
    void withBusy(async () => {
      await updateBrowserTaskAutonomy({
        taskId: activeTask.taskId,
        autonomy: nextAutonomy,
      });
    });
  };

  const clearHistory = () => {
    if (historyEntries.length === 0 || busy) return;
    if (!window.confirm("Clear browser history?")) return;
    void withBusy(async () => {
      await clearBrowserHistoryCommand();
    });
  };

  const startTask = () => {
    const taskGoal = goal.trim();
    if (!taskGoal || busy) return;
    const startUrl = inferBrowserTaskStartUrl(taskGoal, address.trim());
    setRightPanelTab("chat");
    void withBusy(async () => {
      await startBrowserTaskWithGoal(taskGoal, startUrl);
    });
  };

  const submitTask = (event: FormEvent) => {
    event.preventDefault();
    startTask();
  };

  const submitTaskFromKeyboard = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    startTask();
  };

  const finishTask = (status: "completed" | "blocked") => {
    if (!activeTask) return;
    void withBusy(async () => {
      await browserApiPostJson("/browser/task/finish", { taskId: activeTask.taskId, status });
    });
  };

  const controlTask = (action: "pause" | "resume" | "abort" | "userTakeover") => {
    if (!activeTask) return;
    void withBusy(async () => {
      await browserApiPostJson("/browser/task/control", {
        taskId: activeTask.taskId,
        action,
        requestedBy: UI_BROWSER_AGENT_ID,
      });
    });
  };

  const newTab = (nextProfileId = USER_DEFAULT_PROFILE_ID) => {
    if (nextProfileId === USER_DEFAULT_PROFILE_ID && personalLock.enabled && personalLock.locked) {
      showPersonalLockBlockedNotice();
      return;
    }
    void withBusy(async () => {
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
    void withBusy(async () => {
      const lease = tabLeases[tab.browserTabId];
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
    void withBusy(async () => {
      const lease = tabLeases[tab.browserTabId];
      const response = await browserApiPostJson<{ ok: boolean; tab?: BrowserTab; error?: string }>("/browser/tabs/close", {
        browserTabId: tab.browserTabId,
        ...(lease
          ? {
              lockLeaseId: lease.leaseId,
              ownerAgentId: lease.ownerAgentId,
              ownerRunId: lease.ownerRunId,
            }
          : {}),
      });
      if (!response.ok) {
        throw new Error(response.error || "Browser tab could not be closed because it is locked.");
      }
      setTabLeases((current) => {
        const next = { ...current };
        delete next[tab.browserTabId];
        return next;
      });
    });
  };

  const toggleLockActiveTab = () => {
    if (!activeBrowserTab) return;
    void withBusy(async () => {
      const lease = tabLeases[activeBrowserTab.browserTabId];
      if (activeBrowserTab.lock && lease) {
        await browserApiPostJson("/browser/tabs/unlock", {
          browserTabId: activeBrowserTab.browserTabId,
          leaseId: lease.leaseId,
          ownerAgentId: lease.ownerAgentId,
          ownerRunId: lease.ownerRunId,
        });
        setTabLeases((current) => {
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
        setTabLeases((current) => ({
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

  const setAdMode = (mode: BrowserVisibleAdMode) => {
    void withBusy(async () => {
      await updateBrowserPrivacy({
        profileId: headerProfileId,
        profileAdMode: mode,
      });
      setHeaderMenu(null);
    });
  };

  const setEngineAutomationMode = (mode: BrowserEngineAutomationMode) => {
    void withBusy(async () => {
      await browserApiPostJson("/browser/engine-pool", {
        automationMode: mode,
      });
    });
  };

  const setParallelAgents = (configuredParallelAgents: string) => {
    void withBusy(async () => {
      await browserApiPostJson("/browser/engine-pool", {
        configuredParallelAgents,
      });
    });
  };

  const updatePersonalLockSettings = (patch: {
    enabled?: boolean;
    timeoutMinutes?: number;
    authMode?: BrowserPersonalLockSettings["authMode"];
    blurLockedTabs?: boolean;
    pauseDelegatedTabsWhenLocked?: boolean;
    lockOnSleep?: boolean;
    lockOnMinimize?: boolean;
    newPin?: string;
  }, event?: ShellxUserEventLike | null) => {
    if (!isTrustedShellxUserEvent(event)) {
      return;
    }
    void withBusy(async () => {
      await updateBrowserPersonalLock(patch);
      if (patch.newPin) setPersonalLockPinDraft("");
    });
  };

  const runPersonalLockAction = (
    action: "lockNow" | "unlock",
    pin = personalLockPinDraft,
    event?: ShellxUserEventLike | null,
  ) => {
    if (!isTrustedShellxUserEvent(event)) {
      return;
    }
    let resolvedPin = pin;
    if (action === "unlock" && personalLock.authMode === "pinOnly" && personalLock.pinConfigured && !resolvedPin.trim()) {
      const enteredPin = window.prompt("Enter Personal Browser Lock PIN");
      if (!enteredPin) return;
      resolvedPin = enteredPin;
    }
    void withBusy(async () => {
      await updateBrowserPersonalLock({ action, pin: resolvedPin });
      if (action === "unlock") setPersonalLockPinDraft("");
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
    void withBusy(async () => {
      await delegateBrowserTabToAgent({
        browserTabId: activeBrowserTab.browserTabId,
        taskId: activeTask.taskId,
        reason: "operator handoff from Browser chrome",
      });
    });
  };

  const takeBackActiveTab = () => {
    if (!activeBrowserTab) return;
    void withBusy(async () => {
      await takeBackBrowserTabFromAgent({
        browserTabId: activeBrowserTab.browserTabId,
        reason: "operator takeback from Browser chrome",
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

  const startRightSidebarResize = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = rightSidebarWidth;
    const onPointerMove = (moveEvent: globalThis.PointerEvent) => {
      const nextWidth = Math.round(Math.min(560, Math.max(280, startWidth - (moveEvent.clientX - startX))));
      setRightSidebarWidth(nextWidth);
    };
    const stopResize = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  };

  const toggleSection = (section: BrowserSectionId) => {
    setCollapsedSections((current) => ({ ...current, [section]: !current[section] }));
  };
  const toggleHeaderMenu = (menu: BrowserHeaderMenuId) => {
    setOptionsOpen(false);
    setBookmarkManagerOpen(false);
    setOpenToolbarFolderId(null);
    if (menu === "vaultFill") {
      setVaultFillObservationRefresh((current) => current + 1);
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
  const downloadsSidecarOpen = headerMenu === "downloads";
  const settingsSidecarOpen = optionsOpen;
  const leftSidecarOpen = bookmarkManagerOpen || historySidecarOpen || downloadsSidecarOpen || settingsSidecarOpen;
  const leftSidecarWidth = settingsSidecarOpen ? 344 : 312;
  const gridClassName = [
    "shellx-browser-grid",
    leftSidecarOpen ? "with-left-sidecar" : "",
    showRightSidebar ? "" : "hide-right",
  ].filter(Boolean).join(" ");
  const gridColumns = leftSidecarOpen
    ? showRightSidebar
      ? `${leftSidecarWidth}px minmax(0, 1fr) ${rightSidebarWidth}px`
      : `${leftSidecarWidth}px minmax(0, 1fr)`
    : showRightSidebar
      ? `minmax(0, 1fr) ${rightSidebarWidth}px`
      : undefined;
  const gridStyle = gridColumns ? { gridTemplateColumns: gridColumns } : undefined;

  const startBookmarkDrag = (event: DragEvent<HTMLElement>, bookmark: BrowserBookmark) => {
    if (busy) {
      event.preventDefault();
      return;
    }
    setDraggedBookmarkId(bookmark.bookmarkId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", bookmark.bookmarkId);
  };

  const startBookmarkPointerDrag = (event: PointerEvent<HTMLButtonElement>, bookmark: BrowserBookmark) => {
    if (busy) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    bookmarkPointerDragRef.current = {
      bookmarkId: bookmark.bookmarkId,
      startX: event.clientX,
      startY: event.clientY,
    };
    setDraggedBookmarkId(bookmark.bookmarkId);
    window.removeEventListener("pointerup", finishBookmarkPointerDrag);
    window.removeEventListener("pointercancel", cancelBookmarkPointerDrag);
    window.addEventListener("pointerup", finishBookmarkPointerDrag);
    window.addEventListener("pointercancel", cancelBookmarkPointerDrag);
  };

  const renderChromeMenuPanel = (): JSX.Element | null => {
    if (headerMenu === "shields") {
      return (
        <BrowserShieldsPanel
          busy={busy}
          globalShields={state?.shields}
          activeShieldState={activeShieldState}
          onUpdateGlobal={updateGlobalShields}
          onSaveSite={saveSiteShields}
          onResetSite={resetSiteShields}
        />
      );
    }

    if (headerMenu === "save") {
      return (
        <BrowserPageSaveMenu
          busy={busy}
          canSavePage={Boolean(currentPageUrlForSave(state, activeTask, activeBrowserTab, address))}
          onRequestPageSave={requestPageSave}
        />
      );
    }

    if (headerMenu === "ads") {
      return (
        <BrowserAdFilterMenu busy={busy} selectedAdMode={selectedAdMode} onSetAdMode={setAdMode} />
      );
    }

    if (headerMenu === "vaultFill") {
      return (
        <section className="shellx-browser-header-popover shellx-browser-docked-popover shellx-browser-vault-fill-panel" data-debug-id="shellx-browser-vault-fill-panel">
          <div className="shellx-browser-vault-fill-head">
            <strong>Fill from Vault</strong>
            <span>
              {vaultFillError
                ? "Vault unavailable"
                : `${vaultFillCandidates.length} match${vaultFillCandidates.length === 1 ? "" : "es"}`}
            </span>
          </div>
          {vaultFillError ? (
            <div className="shellx-browser-vault-fill-empty" data-debug-id="shellx-browser-vault-fill-unavailable">
              Unlock Vault, then return to this page. ShellX will retry saved-secret detection automatically.
            </div>
          ) : vaultFillCandidates.length === 0 ? (
            <div className="shellx-browser-vault-fill-empty">No matching password, API key, or token fields on this page.</div>
          ) : (
            <div className="shellx-browser-vault-fill-list">
              {vaultFillCandidates.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  className="shellx-browser-vault-fill-suggestion"
                  onClick={(event) => handleVaultFillCandidate(candidate, event)}
                  disabled={busy}
                  data-debug-id="shellx-browser-vault-fill-suggestion"
                  title={`Fill ${candidate.fieldLabel}`}
                >
                  <span className="shellx-browser-vault-fill-kind">{candidate.fieldKind}</span>
                  <span className="shellx-browser-vault-fill-main">
                    <strong>{candidate.label}</strong>
                    <small>{candidate.description}</small>
                    <span className="shellx-browser-vault-fill-target">Target: {candidate.fieldLabel}</span>
                  </span>
                  {candidate.userOnly && <span className="shellx-browser-vault-fill-user-only">user</span>}
                </button>
              ))}
            </div>
          )}
        </section>
      );
    }

    return null;
  };

  const chromeMenuPanel = renderChromeMenuPanel();
  const chromeMenuAlign = headerMenu === "shields" ? "align-left" : "align-right";
  const personalLockNoticeVisible = error?.startsWith("Personal Browser Lock is on.") === true;

  return (
    <main className="shellx-browser-app" data-color-mode={colorMode}>
      <DebugHighlightOverlay surface="browser" highlights={debugHighlights} />
      <BrowserChrome
        tabs={tabs}
        activeBrowserTab={activeBrowserTab}
        draggedTabId={draggedTabId}
        tabLeases={tabLeases}
        busy={busy}
        showRightSidebar={showRightSidebar}
        address={address}
        addressCopied={addressCopied}
        activeSecurityState={activeSecurityState}
        headerMenu={headerMenu}
        optionsOpen={optionsOpen}
        bookmarkManagerOpen={bookmarkManagerOpen}
        canUseHistoryControls={Boolean(activeBrowserTab)}
        canUseCurrentPage={Boolean(currentPageUrlForSave(state, activeTask, activeBrowserTab, address))}
        transferIntentCount={transfers.length}
        activeTransferCount={activeTransferCount}
        vaultFillCount={vaultFillCandidates.length || (vaultFillError ? vaultFillDetectedFieldCount : 0)}
        headerProfileId={headerProfileId}
        headerProfileDescription={headerProfile?.description ?? null}
        personalLock={personalLock}
        personalTabLocked={personalTabLocked}
        personalLockAttention={personalLockAttention}
        canHandOffActiveTab={canHandOffActiveTab}
        canTakeBackActiveTab={canTakeBackActiveTab}
        chromeMenuPanel={chromeMenuPanel}
        chromeMenuAlign={chromeMenuAlign}
        browserProfileMarker={browserProfileMarker}
        browserProfileShortLabel={browserProfileShortLabel}
        browserTrustIcon={browserTrustIcon}
        browserTrustLabel={browserTrustLabel}
        onSetDraggedTabId={setDraggedTabId}
        onReorderTabs={reorderTabs}
        onFocusTab={focusTab}
        onCloseTab={closeTab}
        onNewTab={newTab}
        onToggleLockActiveTab={toggleLockActiveTab}
        onPersonalLockAction={runPersonalLockAction}
        onHandOffActiveTab={handOffActiveTab}
        onTakeBackActiveTab={takeBackActiveTab}
        onShowRightSidebar={() => setShowRightSidebar(true)}
        onSubmitAddress={submitAddress}
        onRunAction={runAction}
        onGoHome={goHome}
        onToggleHeaderMenu={toggleHeaderMenu}
        onSetAddressEditing={setAddressEditing}
        onAddressChange={setAddress}
        onCopyAddress={copyAddress}
        onBookmarkCurrent={bookmarkCurrent}
        onToggleBookmarksPanel={toggleBookmarksPanel}
        onToggleOptions={toggleOptionsPanel}
      />

      {error && (
        <div
          className={`shellx-browser-error ${personalLockNoticeVisible ? "shellx-browser-lock-notice" : ""}`}
          data-debug-id={personalLockNoticeVisible ? "shellx-browser-personal-lock-notice" : "shellx-browser-error"}
        >
          <span>{error}</span>
          {personalLockNoticeVisible && (
            <button
              type="button"
              className="settings-pill"
              onClick={(event) => runPersonalLockAction("unlock", personalLockPinDraft, event)}
              disabled={personalLock.authMode === "pinOnly" && personalLock.pinConfigured && !personalLockPinDraft.trim()}
              data-debug-id="shellx-browser-personal-lock-notice-unlock"
            >
              Unlock
            </button>
          )}
        </div>
      )}

      <BookmarkToolbar
        bookmarkToolbar={bookmarkToolbar}
        openToolbarFolder={openToolbarFolder}
        openToolbarFolderId={openToolbarFolderId}
        bookmarkUrl={bookmarkUrl}
        onNavigateToToolbarUrl={navigateToUrl}
        onSetOpenToolbarFolderId={setOpenToolbarFolderId}
      />

      <div className={gridClassName} style={gridStyle}>
        {settingsSidecarOpen && (
          <BrowserOptionsMenu
            colorMode={colorMode}
            homeUrl={homeUrl}
            profileId={profileId}
            profiles={state?.profiles ?? []}
            engineMode={enginePool?.automationMode === "backgroundOnly" ? "backgroundOnly" : "normal"}
            configuredParallelAgents={enginePool?.limits?.configuredParallelAgents ?? "auto"}
            showRightSidebar={showRightSidebar}
            personalLock={personalLock}
            personalLockPinDraft={personalLockPinDraft}
            profileLabel={browserProfileLabel}
            onColorModeChange={setColorMode}
            onHomeUrlChange={setHomeUrl}
            onProfileChange={setProfileId}
            onEngineModeChange={setEngineAutomationMode}
            onParallelAgentsChange={setParallelAgents}
            onShowRightSidebarChange={setShowRightSidebar}
            onPersonalLockPatch={updatePersonalLockSettings}
            onPersonalLockAction={runPersonalLockAction}
            onPersonalLockPinDraftChange={setPersonalLockPinDraft}
            onClose={() => setOptionsOpen(false)}
          />
        )}

        <BrowserHistorySidecar
          open={historySidecarOpen}
          busy={busy}
          historyScope={historyScope}
          historySearch={historySearch}
          historyDateFilter={historyDateFilter}
          historyEntries={historyEntries}
          userHistory={userHistory}
          agentHistory={agentHistory}
          formatHistoryTime={formatHistoryTime}
          onHistoryScopeChange={setHistoryScope}
          onHistorySearchChange={setHistorySearch}
          onHistoryDateFilterChange={setHistoryDateFilter}
          onClearHistory={clearHistory}
          onNavigateToUrl={navigateToUrl}
          onClose={() => setHeaderMenu(null)}
        />

        <DownloadSidecar
          open={downloadsSidecarOpen}
          busy={busy}
          downloads={downloads}
          uploads={uploads}
          defaultDownloadFolder={defaultDownloadFolder}
          onDefaultDownloadFolderChange={setDefaultDownloadFolder}
          onChooseDefaultDownloadFolder={chooseDefaultDownloadFolder}
          onClose={() => setHeaderMenu(null)}
        />

        <BookmarkSidecar
          open={bookmarkManagerOpen}
          busy={busy}
          bookmarkManageMode={bookmarkManageMode}
          bookmarks={bookmarks}
          rootBookmarks={rootBookmarks}
          bookmarkFolders={bookmarkFolders}
          bookmarkChildrenByParent={bookmarkChildrenByParent}
          bookmarkDraftLabel={bookmarkDraftLabel}
          bookmarkDraftUrl={bookmarkDraftUrl}
          bookmarkDraftParentId={bookmarkDraftParentId}
          bookmarkDeleteId={bookmarkDeleteId}
          bookmarkRenameDrafts={bookmarkRenameDrafts}
          bookmarkUrlDrafts={bookmarkUrlDrafts}
          draggedBookmarkId={draggedBookmarkId}
          bookmarkUrl={bookmarkUrl}
          onOpenBookmark={openBookmark}
          onToggleBookmarkPin={toggleBookmarkPin}
          onCreateFolder={createBookmarkFolder}
          onCreateLink={createBookmarkLink}
          onDraftLabelChange={setBookmarkDraftLabel}
          onDraftUrlChange={setBookmarkDraftUrl}
          onDraftParentChange={setBookmarkDraftParentId}
          onRenameDraftChange={updateBookmarkRenameDraft}
          onResetRenameDraft={resetBookmarkRenameDraft}
          onUrlDraftChange={updateBookmarkUrlDraft}
          onResetUrlDraft={resetBookmarkUrlDraft}
          onCommitRename={commitBookmarkRename}
          onCommitUrl={commitBookmarkUrl}
          onDeleteBookmark={deleteBookmark}
          onDropBookmarkBefore={dropBookmarkBefore}
          onDropBookmarkIntoFolder={dropBookmarkIntoFolder}
          onStartBookmarkDrag={startBookmarkDrag}
          onStartBookmarkPointerDrag={startBookmarkPointerDrag}
          onSetBookmarkManagerOpen={setBookmarkManagerOpen}
          onSetBookmarkManageMode={setBookmarkManageMode}
        />

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
              {personalLock.authMode === "pinOnly" && personalLock.pinConfigured && (
                <input
                  type="password"
                  value={personalLockPinDraft}
                  onChange={(event) => setPersonalLockPinDraft(event.target.value)}
                  placeholder="PIN"
                  data-debug-id="shellx-browser-personal-lock-overlay-pin"
                />
              )}
              <button
                type="button"
                className="settings-pill active"
                onClick={(event) => runPersonalLockAction("unlock", personalLockPinDraft, event)}
                disabled={personalLock.authMode === "pinOnly" && personalLock.pinConfigured && !personalLockPinDraft.trim()}
                data-debug-id="shellx-browser-personal-lock-overlay-unlock"
              >
                Unlock personal tabs
              </button>
            </div>
          )}
        </div>

        <AgentSidebar
          show={showRightSidebar}
          rightPanelTab={rightPanelTab}
          autonomy={displayedAutonomy}
          goal={goal}
          busy={busy}
          activeTask={activeTask}
          browserChatMessages={browserChatMessages}
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
          onResizeStart={startRightSidebarResize}
          onHideRightSidebar={() => setShowRightSidebar(false)}
          onSelectRightPanelTab={selectRightPanelTab}
          onAutonomyChange={setTaskAutonomy}
          onGoalChange={setGoal}
          onSubmitTask={submitTask}
          onSubmitTaskFromKeyboard={submitTaskFromKeyboard}
          onControlTask={controlTask}
          onFinishTask={finishTask}
          onToggleSection={toggleSection}
          onVaultPromptAction={handleVaultPromptAction}
        />
      </div>
    </main>
  );
}
