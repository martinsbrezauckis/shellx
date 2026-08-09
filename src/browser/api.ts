import { invoke } from "@tauri-apps/api/core";

import { apiDeleteJson, apiGet, apiPostJson, debugApiBase, getDebugToken } from "../lib/debug-api";
import { inTauri } from "../lib/tauri-bridge";
import type {
  BrowserAutonomy,
  BrowserPersonalLockSettings,
  BrowserReceipt,
  BrowserShieldSettings,
  BrowserTabShieldState,
  BrowserTask,
  BrowserVisibleAdMode,
} from "./types";

export interface BrowserEngineSyncRequest {
  engineId: string | null;
  browserTabId: string | null;
  profileId: string;
  url: string | null;
  preserveExistingPage?: boolean;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface BrowserPrivacyUpdateRequest {
  profileId: string;
  profileAdMode?: BrowserVisibleAdMode;
  clearProfileAdMode?: boolean;
}

export interface BrowserTaskControlCommandRequest {
  taskId?: string | null;
  action: "pause" | "resume" | "abort" | "userTakeover";
  reason?: string | null;
}

export interface BrowserCoworkPromptRequest {
  taskId?: string | null;
  targetTabId: string;
  prompt: string;
  startUrl?: string | null;
  profileId?: string | null;
  autonomy?: BrowserAutonomy | null;
}

export interface BrowserCoworkPromptResponse {
  ok: boolean;
  requestId: string;
  createdTask: boolean;
  task: BrowserTask;
  browserTabId: string;
  targetTabId: string;
  receipt: BrowserReceipt;
}

export interface BrowserVaultFillActionResponse {
  ok?: boolean;
  status?: string;
  message?: string | null;
  observation?: unknown;
}

export function normalizeBrowserVaultFillActionResponse(
  value: unknown,
): BrowserVaultFillActionResponse {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ShellX Browser Vault fill returned an invalid response.");
  }
  const ok = Reflect.get(value, "ok");
  const status = Reflect.get(value, "status");
  const message = Reflect.get(value, "message");
  if (ok !== undefined && typeof ok !== "boolean") {
    throw new Error("ShellX Browser Vault fill returned an invalid ok field.");
  }
  if (status !== undefined && typeof status !== "string") {
    throw new Error("ShellX Browser Vault fill returned an invalid status field.");
  }
  if (message !== undefined && message !== null && typeof message !== "string") {
    throw new Error("ShellX Browser Vault fill returned an invalid message field.");
  }
  return {
    ok,
    status,
    message,
    observation: Reflect.get(value, "observation"),
  };
}

export interface BrowserPersonalLockUpdateRequest {
  enabled?: boolean;
  timeoutMinutes?: number;
  authMode?: "deviceAuthPreferred" | "pinOnly";
  blurLockedTabs?: boolean;
  pauseDelegatedTabsWhenLocked?: boolean;
  lockOnSleep?: boolean;
  lockOnMinimize?: boolean;
  action?: "lockNow" | "unlock" | "trustedActivity";
  pin?: string;
  newPin?: string;
  trustedUserActivity?: boolean;
}

export interface BrowserTransferApproval {
  approvalId: string;
  transferId: string;
  direction: string;
  origin?: string | null;
  sha256?: string | null;
  status: string;
  createdAtMs: number;
  expiresAtMs: number;
  consumedAtMs?: number | null;
}

export interface BrowserLocalArtifact {
  finalPath: string;
  displayName: string;
  mimeType?: string | null;
  bytes: number;
  sha256: string;
}

export interface BrowserVaultKeyMeta {
  key: string;
  description?: string | null;
  userOnly?: boolean;
  resourceKind?: "secret" | "profileCard" | "emailInbox" | "stripeAgentWallet";
  resourceSummary?: string | null;
  resourceProvider?: string | null;
  resourceFields?: string[];
  lastModifiedMs?: number;
}

export function browserDebugApiBase(): Promise<string> {
  return debugApiBase();
}

export function getBrowserDebugToken(): Promise<string> {
  return getDebugToken();
}

export function browserApiGet<T = unknown>(path: string): Promise<T> {
  return apiGet<T>(path);
}

export function browserApiPostJson<T = unknown>(path: string, body: unknown): Promise<T> {
  return apiPostJson<T>(path, body);
}

export function browserApiDeleteJson<T = unknown>(path: string): Promise<T> {
  return apiDeleteJson<T>(path);
}

export async function loadBrowserEvidenceForOperator(limit = 20): Promise<unknown> {
  if (!inTauri()) {
    throw new Error("Browser evidence is available only inside the ShellX desktop app.");
  }
  return await invoke<unknown>("shellx_browser_operator_evidence_summary", { limit });
}

export async function exportBrowserFlightRecorderForOperator(request: {
  taskId: string;
  reason?: string | null;
}): Promise<unknown> {
  if (!inTauri()) {
    throw new Error("Browser Flight Recorder export is available only inside the ShellX desktop app.");
  }
  return await invoke<unknown>("shellx_browser_operator_export_flight_recorder", { request });
}

export async function syncBrowserEngine(request: BrowserEngineSyncRequest): Promise<void> {
  await invoke("shellx_browser_sync_engine", { request });
}

export async function resolveBrowserSessionGrant(request: { grantId: string; approved: boolean }): Promise<void> {
  await invoke("shellx_browser_resolve_session_grant", request);
}

export async function openBrowserVaultPanel(): Promise<void> {
  await invoke("shellx_browser_open_vault_panel");
}

export async function listBrowserVaultKeys(): Promise<BrowserVaultKeyMeta[]> {
  if (!inTauri()) return [];
  return await invoke<BrowserVaultKeyMeta[]>("vault_list_keys_with_meta");
}

export async function fillUserVaultSecret(request: {
  browserTabId: string;
  secretRef: string;
  refId?: string | null;
  selector?: string | null;
  expectedOrigin: string;
}): Promise<BrowserVaultFillActionResponse> {
  if (!inTauri()) {
    throw new Error("Manual Vault fills are available only inside the ShellX desktop app.");
  }
  const response = await invoke<unknown>("shellx_browser_fill_user_vault_secret", { request });
  return normalizeBrowserVaultFillActionResponse(response);
}

export async function clearBrowserHistoryCommand(): Promise<void> {
  await invoke("shellx_browser_clear_history");
}

export async function controlBrowserTaskFromOperator(request: BrowserTaskControlCommandRequest): Promise<void> {
  if (!inTauri()) {
    throw new Error("Browser task operator controls are available only inside the ShellX desktop app.");
  }
  await invoke("shellx_browser_control_task", { request });
}

export async function finishBrowserTaskFromOperator(request: {
  taskId?: string | null;
  status: "completed" | "blocked" | "aborted";
  reason?: string | null;
}): Promise<void> {
  if (!inTauri()) {
    throw new Error("Browser task operator controls are available only inside the ShellX desktop app.");
  }
  await invoke("shellx_browser_finish_task", request);
}

export async function sendBrowserCoworkPrompt(
  request: BrowserCoworkPromptRequest,
): Promise<BrowserCoworkPromptResponse> {
  if (!inTauri()) {
    throw new Error("Browser coworking is available only inside the ShellX desktop app.");
  }
  return await invoke<BrowserCoworkPromptResponse>("shellx_browser_send_cowork_prompt", { request });
}

export async function grantBrowserTransfer(request: {
  transferId: string;
  direction: "download" | "upload";
  origin?: string | null;
  sha256?: string | null;
  ttlSeconds?: number | null;
}): Promise<BrowserTransferApproval> {
  return await invoke<BrowserTransferApproval>("shellx_browser_grant_transfer", { request });
}

export async function writeBrowserTextArtifact(request: {
  destinationDir?: string | null;
  fileName?: string | null;
  content: string;
}): Promise<BrowserLocalArtifact> {
  return await invoke<BrowserLocalArtifact>("shellx_browser_write_text_artifact", { request });
}

export async function copyBrowserLocalArtifact(request: {
  sourcePath: string;
  destinationDir?: string | null;
  fileName?: string | null;
}): Promise<BrowserLocalArtifact> {
  return await invoke<BrowserLocalArtifact>("shellx_browser_copy_local_artifact", { request });
}

export async function updateBrowserDownloadFolder(downloadFolder: string): Promise<void> {
  if (inTauri()) {
    await invoke("shellx_browser_update_download_folder", { request: { downloadFolder } });
    return;
  }
  throw new Error("Browser download folder changes are available only inside the ShellX desktop app.");
}

export async function updateBrowserPersonalLock(request: BrowserPersonalLockUpdateRequest): Promise<BrowserPersonalLockSettings> {
  if (inTauri()) {
    const response = await invoke<{ personalLock: BrowserPersonalLockSettings }>("shellx_browser_update_personal_lock", { request });
    return response.personalLock;
  }
  throw new Error("Personal Browser Lock changes are available only inside the ShellX desktop app.");
}

export async function delegateBrowserTabToAgent(request: {
  browserTabId: string;
  taskId: string;
  grantId?: string | null;
  reason?: string | null;
}): Promise<void> {
  if (inTauri()) {
    await invoke("shellx_browser_delegate_tab_to_agent", { request });
    return;
  }
  throw new Error("Browser tab handoff is available only inside the ShellX desktop app.");
}

export async function takeBackBrowserTabFromAgent(request: {
  browserTabId: string;
  reason?: string | null;
}): Promise<void> {
  if (inTauri()) {
    await invoke("shellx_browser_take_back_tab_from_agent", { request });
    return;
  }
  throw new Error("Browser tab takeback is available only inside the ShellX desktop app.");
}

export async function updateBrowserPrivacy(request: BrowserPrivacyUpdateRequest): Promise<void> {
  if (inTauri()) {
    await invoke("shellx_browser_update_privacy", { request });
    return;
  }
  await browserApiPostJson("/browser/privacy", request);
}

export async function updateBrowserShields(patch: Partial<BrowserShieldSettings>): Promise<void> {
  if (inTauri()) {
    await invoke("shellx_browser_update_shields", { request: patch });
    return;
  }
  await browserApiPostJson("/browser/shields", patch);
}

export async function updateBrowserSiteShields(request: {
  host: string;
  adTrackerMode: BrowserTabShieldState["effectiveAdTrackerMode"];
  cookieMode: BrowserTabShieldState["effectiveCookieMode"];
  fingerprintingMode: BrowserTabShieldState["effectiveFingerprintingMode"];
  httpsUpgradeEnabled: boolean;
  scriptBlockingEnabled: boolean;
}): Promise<void> {
  if (inTauri()) {
    await invoke("shellx_browser_update_site_shields", { request });
    return;
  }
  await browserApiPostJson("/browser/shields/site", request);
}

export async function removeBrowserSiteShields(host: string): Promise<void> {
  if (inTauri()) {
    await invoke("shellx_browser_remove_site_shields", { request: { host } });
    return;
  }
  await browserApiDeleteJson(`/browser/shields/site/${encodeURIComponent(host)}`);
}
