import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const tokenFile = requiredArg("--token-file");
const token = readFileSync(tokenFile, "utf8").trim();
const stateOut = requiredArg("--state-out");
const instanceId = requiredArg("--instance-id");
const processId = Number(requiredArg("--process-id"));
const version = requiredArg("--version");
const sourceCommit = requiredArg("--source-commit");

type Surface = "app" | "browser";
type Highlight = { id?: string; selector?: string };
type BrowserOverlay = "none" | "options" | "history" | "bookmarks-list" | "bookmarks-manager";
type Bookmark = {
  bookmarkId: string;
  kind: "folder" | "link";
  label: string;
  url?: string;
  parentId?: string;
  agentWorkflow?: { recipePath: string; goal?: string };
};
type HighlightResult = Highlight & {
  status: "resolved" | "missing";
  visibleRect?: { width: number; height: number };
  message?: string;
};

let openModal = "close";
let pluginsFixtureActive = false;
let pluginsKeyFormEntryId: string | null = null;
let connectorsFixtureActive = false;
let connectorDraftOpen = false;
let connectorTargetMode: "activeTab" | "fixedTab" = "activeTab";
let buildPlanFixtureActive = false;
let shellxagentFixtureActive = false;
let appBottomTab = "Chat";
let agentCliSetupFixtureMode: "closed" | "cards" | "confirmation" | "status-card" = "closed";
let goalPlanReviewFixtureMode: "closed" | "review" | "editing" = "closed";
let setupGuideDismissed = true;
let appRightTab = "Tasks";
let tasksPanelOwnedRowActive = false;
let vaultClipboardFixtureActive = false;
let settingsTab = "data";
let browserRightTab = "chat";
let browserOverlay: BrowserOverlay = "none";
let builtinDocOpen = false;
let activityEvidenceVisible = false;
let activityView: "files" | "graph" | "evidence" | "timeline" = "files";
let ownedActivityBrowserActive = false;
let ownedActivityGraphSelected = false;
let activitySearchValue = "";
let findPopoverOpen = false;
let findSearchValue = "";
let pastChatVisible = false;
let pastChatRenaming = false;
let cwdPickerMode: "closed" | "generic" | "empty" | "with-child" = "closed";
let ownedGitRepoActive = false;
let ownedFilesPaneActive = false;
let branchPickerOpen = false;
let connectionPickerOpen = false;
let ownedConnectionSelected = false;
let ownedConnectionEditorOpen = false;
let agentPickerOpen = false;
let slashPickerOpen = false;
let passwordGeneratorOpen = false;
let vaultSetupVisible = false;
let vaultMasterPassphrase = "";
let vaultConfirmPassphrase = "";
let vaultRecoveryKitVisible = false;
let vaultRowMode: "none" | "metadata" | "replace" = "none";
let vaultRequestCenterOpen = false;
let vaultGrantsTabActive = false;
let vaultStatus = vaultBaselineStatus();
let vaultConfirmationId: string | null = null;
let vaultAgentRequest: Record<string, unknown> | null = null;
let vaultGrant: Record<string, unknown> | null = null;
let browserSidebarVisible = true;
let browserTaskActive = false;
let browserHistoryEntryCount = 0;
let browserWorkflowPreviewVisible = false;
let browserErrorVisible = false;
let taskStartCount = 0;
let taskAbortCount = 0;
let ownedProjectDraft = false;
let ownedProjectRenaming = false;
let ownedProjectRenameValue = "";
let ownedProjectDeleteDialog = false;
let openChatContextMenu = false;
let pastChatContextMenu = false;
let sessionRenaming = false;
let sessionPreviewVisible = false;
let ownedVideoPreviewActive = false;
let ownedMarkdownPreviewActive = false;
let ownedPendingAttachmentActive = false;
let ownedRendererEventProjectionActive = false;
let providerActionFixture: "none" | "right-rail-connector-action" = "none";
let debugUiConnectionFixture: "clear" | "disconnected" = "clear";
let hashItemsFixtureActive = false;
let composerPromptValue = "";
let ownedWorkPreviewIssueMounted = false;
let workPreviewIssueStatus: "idle" | "running" | "stopped" = "idle";
let workPreviewIssueTabId: string | null = null;
let workPreviewIssueCwd: string | null = null;
let workPreviewIssueUrl: string | null = null;
let sessionDropdownOpen = false;
let sessionDeleteDialogOpen = false;
const bookmarks = new Map<string, Bookmark>();
const connectionPresets = new Map<string, Record<string, unknown>>();
const vaultEntries = new Set<string>();
const results: Record<Surface, HighlightResult[]> = { app: [], browser: [] };

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && requestUrl.pathname === "/owned-work-preview-issue") {
    if (workPreviewIssueStatus !== "running") return json(response, 404, { error: "preview stopped" });
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return response.end("<!doctype html><main>SHELLX_RELEASE_OWNED_WORK_PREVIEW_WARNING_035</main>\n");
  }
  if (request.headers.authorization !== `Bearer ${token}`) return json(response, 401, { error: "unauthorized" });
  const address = server.address();
  if (!address || typeof address === "string") return json(response, 503, { error: "not ready" });

  if (request.method === "GET" && request.url === "/health") {
    return json(response, 200, {
      processId,
      instanceId,
      appVersion: version,
      buildCommit: sourceCommit,
      debugApiPort: address.port,
    });
  }
  if (request.method === "GET" && requestUrl.pathname === "/preview/work/state") {
    const tabId = requestUrl.searchParams.get("tabId") ?? "";
    return json(response, 200, workPreviewIssueState(tabId));
  }
  if (request.method === "POST" && requestUrl.pathname === "/preview/work/start") {
    const body = await readJsonBody(request);
    const tabId = requestUrl.searchParams.get("tabId") ?? "";
    if (!tabId || body.tabId !== tabId || typeof body.cwd !== "string" || !body.cwd
      || body.kind !== "static" || body.entry !== "release-preview.html"
      || workPreviewIssueStatus !== "idle") {
      return json(response, 400, { error: "invalid owned Work Preview start" });
    }
    workPreviewIssueTabId = tabId;
    workPreviewIssueCwd = body.cwd;
    workPreviewIssueStatus = "running";
    workPreviewIssueUrl = `http://127.0.0.1:${address.port}/owned-work-preview-issue`;
    return json(response, 200, workPreviewIssueState(tabId));
  }
  if (request.method === "POST" && requestUrl.pathname === "/preview/work/stop") {
    const body = await readJsonBody(request);
    const tabId = requestUrl.searchParams.get("tabId") ?? "";
    if (!tabId || body.tabId !== tabId || tabId !== workPreviewIssueTabId) {
      return json(response, 400, { error: "invalid owned Work Preview stop" });
    }
    workPreviewIssueStatus = "stopped";
    workPreviewIssueUrl = null;
    return json(response, 200, workPreviewIssueState(tabId));
  }
  if (request.method === "GET" && request.url === "/browser/state") {
    return json(response, 200, {
      profiles: [{ profileId: "task-disposable", isolation: "disposable" }],
      tabs: browserTaskActive ? [{ browserTabId: "owned-ui-debug-tab", taskId: "owned-ui-debug-task" }] : [],
      tasks: browserTaskActive ? [{ taskId: "owned-ui-debug-task", status: "running" }] : [],
      windowOpen: browserTaskActive,
    });
  }
  if (request.method === "GET" && request.url === "/connections") {
    return json(response, 200, { presets: [...connectionPresets.values()] });
  }
  if (request.method === "POST" && request.url === "/connections") {
    const body = await readJsonBody(request);
    if (typeof body.label !== "string" || !body.label || connectionPresets.size > 0) {
      return json(response, 400, { error: "invalid owned connection fixture" });
    }
    const preset = {
      ...body,
      id: "conn-owned-ui-debug",
      createdMs: 1_000,
      lastUsedMs: 0,
    };
    connectionPresets.set(String(preset.id), preset);
    return json(response, 201, preset);
  }
  if (request.method === "DELETE" && request.url?.startsWith("/connections/")) {
    const id = decodeURIComponent(request.url.slice("/connections/".length));
    if (!connectionPresets.delete(id)) return json(response, 404, { error: "unknown owned connection fixture" });
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method === "POST" && request.url === "/browser/task/start") {
    const body = await readJsonBody(request);
    if (body.autonomy !== "assistedAutonomous") {
      return json(response, 400, { error: "Browser fixture requires the enforced assistedAutonomous policy" });
    }
    browserTaskActive = true;
    browserSidebarVisible = true;
    browserHistoryEntryCount += 1;
    taskStartCount += 1;
    return json(response, 200, {
      taskId: "owned-ui-debug-task",
      browserTabId: "owned-ui-debug-tab",
      status: "running",
    });
  }
  if (request.method === "POST" && request.url === "/browser/task/control") {
    const body = await readJsonBody(request);
    if (body.taskId !== "owned-ui-debug-task" || body.action !== "abort") {
      return json(response, 409, { error: "owned task mismatch" });
    }
    browserTaskActive = false;
    taskAbortCount += 1;
    return json(response, 200, { taskId: body.taskId, status: "aborted" });
  }
  if (request.method === "GET" && request.url === "/browser/bookmarks") {
    return json(response, 200, { bookmarks: [...bookmarks.values()] });
  }
  if (request.method === "POST" && request.url === "/browser/bookmarks") {
    const body = await readJsonBody(request);
    const bookmark = readBookmark(body);
    bookmarks.set(bookmark.bookmarkId, bookmark);
    return json(response, 200, { bookmark });
  }
  if (request.method === "DELETE" && request.url?.startsWith("/browser/bookmarks/")) {
    const bookmarkId = decodeURIComponent(request.url.slice("/browser/bookmarks/".length));
    if (!bookmarks.delete(bookmarkId)) return json(response, 404, { error: "bookmark not found" });
    if (bookmarkId === "final-surface-missing-workflow") {
      browserWorkflowPreviewVisible = false;
      browserErrorVisible = false;
    }
    return json(response, 200, { bookmarkId, deleted: true });
  }
  if (request.method === "GET" && request.url === "/vault/keys") {
    const keys = [...vaultEntries].sort();
    return json(response, 200, {
      keys,
      entries: keys.map((key) => ({ key, resourceKind: "secret", description: null, userOnly: false })),
    });
  }
  if (request.method === "GET" && request.url === "/vault/status") {
    return json(response, 200, vaultStatus);
  }
  if (request.method === "GET" && request.url === "/vault/grants") {
    return json(response, 200, { grants: vaultGrant ? [vaultGrant] : [] });
  }
  if (request.method === "POST" && request.url === "/vault/e2e/seed-secret") {
    const body = await readJsonBody(request);
    if (typeof body.secretRef !== "string" || !body.secretRef || typeof body.value !== "string" || !body.value) {
      return json(response, 400, { error: "invalid owned Vault grant seed" });
    }
    vaultEntries.add(body.secretRef);
    return json(response, 200, {
      ok: true,
      secretRef: body.secretRef,
      secretPresent: true,
      secretExposed: false,
    });
  }
  if (request.method === "POST" && request.url === "/vault/e2e/approve-grant") {
    const body = await readJsonBody(request);
    if (vaultGrant || typeof body.secretRef !== "string" || !vaultEntries.has(body.secretRef)
      || body.operation !== "fill" || body.origin !== "https://example.com"
      || !Number.isSafeInteger(body.expiresAtMs)) {
      return json(response, 400, { error: "invalid owned Vault grant approval" });
    }
    vaultGrant = {
      grantId: "vault-grant-owned-ui-debug",
      secretRef: body.secretRef,
      actorScope: "allShellxAgents",
      operation: "Fill",
      origin: body.origin,
      createdAtMs: 1_000,
      expiresAtMs: body.expiresAtMs,
      revoked: false,
      approved: true,
    };
    return json(response, 200, {
      ok: true,
      grant: vaultGrant,
      secretExposed: false,
      receipt: { action: "vaultE2eGrantApproved", secretExposed: false },
    });
  }
  if (request.method === "GET" && request.url?.startsWith("/vault/agent-requests")) {
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    const actorId = requestUrl.searchParams.get("actorId");
    const rows = vaultAgentRequest && (!actorId || vaultAgentRequest.actorId === actorId)
      ? [vaultAgentRequest]
      : [];
    return json(response, 200, {
      pendingCount: rows.filter((row) => row.status === "pending").length,
      requests: rows,
      resources: vaultAgentRequest ? [{ id: "owned-resource" }] : [],
    });
  }
  if (request.method === "POST" && request.url === "/vault/agent-requests") {
    const body = await readJsonBody(request);
    const spec = body.spec && typeof body.spec === "object" && !Array.isArray(body.spec)
      ? body.spec as Record<string, unknown>
      : null;
    const bindings = spec && Array.isArray(spec.bindings) ? spec.bindings : [];
    const binding = bindings[0] && typeof bindings[0] === "object" && !Array.isArray(bindings[0])
      ? bindings[0] as Record<string, unknown>
      : null;
    if (vaultAgentRequest || typeof body.actorId !== "string" || typeof body.actorLabel !== "string"
      || !spec || typeof spec.program !== "string" || !binding
      || typeof binding.resourceId !== "string" || !vaultEntries.has(binding.resourceId)) {
      return json(response, 400, { error: "invalid owned Vault agent request" });
    }
    vaultAgentRequest = {
      requestId: "request-owned-ui-debug",
      requestDigest: "b".repeat(64),
      actorId: body.actorId,
      actorLabel: body.actorLabel,
      status: "pending",
      createdAtMs: 1_000,
      expiresAtMs: 61_000,
      spec,
    };
    return json(response, 200, {
      ok: true,
      status: "pendingOperatorApproval",
      request: vaultAgentRequest,
      secretExposed: false,
    });
  }
  if (request.method === "POST" && /^\/vault\/agent-requests\/[^/]+\/cancel$/.test(request.url ?? "")) {
    const body = await readJsonBody(request);
    const requestId = decodeURIComponent((request.url ?? "").split("/")[3] ?? "");
    if (!vaultAgentRequest || vaultAgentRequest.requestId !== requestId
      || vaultAgentRequest.actorId !== body.actorId || vaultAgentRequest.status !== "pending") {
      return json(response, 400, { error: "unknown owned Vault agent request" });
    }
    vaultAgentRequest = { ...vaultAgentRequest, status: "cancelled" };
    return json(response, 200, { ok: true, request: vaultAgentRequest, secretExposed: false });
  }
  if (request.method === "POST" && request.url === "/vault/e2e/reset") {
    await readJsonBody(request);
    vaultStatus = vaultBaselineStatus();
    vaultConfirmationId = null;
    vaultMasterPassphrase = "";
    vaultConfirmPassphrase = "";
    vaultRecoveryKitVisible = false;
    vaultAgentRequest = null;
    vaultGrant = null;
    vaultEntries.clear();
    return json(response, 200, { ok: true, receipt: { action: "vaultE2eReset", secretExposed: false } });
  }
  if (request.method === "POST" && request.url === "/vault/setup/begin") {
    const body = await readJsonBody(request);
    if (body.target !== "local" || body.rememberDevice !== false
      || typeof body.passphrase !== "string" || !body.passphrase) {
      return json(response, 400, { error: "invalid Vault setup fixture" });
    }
    vaultConfirmationId = "1".repeat(32);
    return json(response, 200, {
      ok: true,
      recoveryKit: {
        confirmationId: vaultConfirmationId,
        words: Array.from({ length: 16 }, (_, index) => index.toString(16).padStart(4, "0")),
        warning: "Save this recovery kit. ShellX cannot recover the vault without it.",
      },
    });
  }
  if (request.method === "POST" && request.url === "/vault/setup/confirm-recovery") {
    const body = await readJsonBody(request);
    if (!vaultConfirmationId || body.confirmationId !== vaultConfirmationId || body.importLegacy !== false) {
      return json(response, 400, { error: "invalid Vault confirmation fixture" });
    }
    vaultConfirmationId = null;
    vaultStatus = {
      mode: "local",
      unlocked: true,
      recoveryConfirmed: true,
      rememberedDeviceEnabled: false,
    };
    return json(response, 200, { ok: true, legacyImport: { importedKeys: 0, skipped: true } });
  }
  if (request.method === "POST" && request.url === "/vault/remember-device") {
    const body = await readJsonBody(request);
    if (body.enabled !== true || typeof body.passphrase !== "string" || !body.passphrase
      || vaultStatus.mode !== "local" || vaultStatus.unlocked !== true) {
      return json(response, 400, { error: "invalid remembered-device fixture" });
    }
    vaultStatus = { ...vaultStatus, rememberedDeviceEnabled: true };
    return json(response, 200, { ok: true, enabled: true });
  }
  if (request.method === "POST" && request.url === "/vault/lock") {
    await readJsonBody(request);
    if (vaultStatus.mode !== "local") return json(response, 400, { error: "Vault is not configured" });
    vaultStatus = { ...vaultStatus, unlocked: false };
    return json(response, 200, { ok: true, unlocked: false, rememberedDeviceEnabled: vaultStatus.rememberedDeviceEnabled });
  }
  if (request.method === "POST" && request.url === "/vault/set") {
    const body = await readJsonBody(request);
    if (typeof body.key !== "string" || !body.key || typeof body.value !== "string" || !body.value
      || vaultEntries.has(body.key)) {
      return json(response, 400, { error: "invalid owned Vault fixture" });
    }
    vaultEntries.add(body.key);
    return json(response, 200, { ok: true, key: body.key });
  }
  if (request.method === "POST" && request.url === "/vault/delete") {
    const body = await readJsonBody(request);
    if (typeof body.key !== "string" || !vaultEntries.delete(body.key)) {
      return json(response, 400, { error: "unknown owned Vault fixture" });
    }
    return json(response, 200, { ok: true, key: body.key });
  }
  if (request.method === "POST" && request.url === "/state/ui") {
    const body = await readJsonBody(request);
    const surface: Surface = body.debugSurface === "browser" ? "browser" : "app";
    if (body.debugPluginsFixture === "owned-safe") {
      pluginsFixtureActive = true;
      pluginsKeyFormEntryId = null;
    } else if (body.debugPluginsFixture === "clear") {
      pluginsFixtureActive = false;
      pluginsKeyFormEntryId = null;
    }
    if (body.debugConnectorsFixture === "owned-safe") {
      connectorsFixtureActive = true;
      connectorDraftOpen = false;
      connectorTargetMode = "activeTab";
    } else if (body.debugConnectorsFixture === "clear") {
      connectorsFixtureActive = false;
      connectorDraftOpen = false;
      connectorTargetMode = "activeTab";
    }
    if (body.debugBuildPlanFixture === "owned-ready") {
      buildPlanFixtureActive = true;
    } else if (body.debugBuildPlanFixture === "clear") {
      buildPlanFixtureActive = false;
    }
    if (body.debugShellxagentFixture === "owned-safe") {
      shellxagentFixtureActive = true;
    } else if (body.debugShellxagentFixture === "clear") {
      shellxagentFixtureActive = false;
    }
    if (typeof body.openModal === "string") {
      openModal = body.openModal;
      if (openModal === "close") builtinDocOpen = false;
      if (openModal === "close") activitySearchValue = "";
      if (openModal === "close") goalPlanReviewFixtureMode = "closed";
      if (openModal === "close") connectorDraftOpen = false;
      if (openModal !== "activity") {
        activityEvidenceVisible = false;
        activityView = "files";
        ownedActivityGraphSelected = false;
      }
      if (openModal !== "vault") passwordGeneratorOpen = false;
      if (openModal !== "vault") vaultSetupVisible = false;
      if (openModal !== "vault") vaultRecoveryKitVisible = false;
      if (openModal !== "vault") vaultRowMode = "none";
      if (openModal !== "vault") vaultGrantsTabActive = false;
    }
    if (typeof body.setupGuideDismissed === "boolean") setupGuideDismissed = body.setupGuideDismissed;
    if (typeof body.bottomTab === "string") appBottomTab = body.bottomTab;
    if (
      body.agentCliSetupFixture === "closed"
      || body.agentCliSetupFixture === "cards"
      || body.agentCliSetupFixture === "confirmation"
      || body.agentCliSetupFixture === "status-card"
    ) {
      agentCliSetupFixtureMode = body.agentCliSetupFixture;
    }
    if (
      body.goalPlanReviewFixture === "closed"
      || body.goalPlanReviewFixture === "review"
      || body.goalPlanReviewFixture === "editing"
    ) {
      goalPlanReviewFixtureMode = body.goalPlanReviewFixture;
    }
    if (typeof body.vaultRequestCenterOpen === "boolean") vaultRequestCenterOpen = body.vaultRequestCenterOpen;
    if (body.preview && typeof body.preview === "object") {
      sessionPreviewVisible = true;
      const preview = body.preview as Record<string, unknown>;
      ownedVideoPreviewActive = typeof preview.path === "string"
        && preview.path.includes("shellx-release-ui-preview-")
        && preview.path.endsWith("owned-preview.mp4");
      ownedMarkdownPreviewActive = typeof preview.path === "string"
        && preview.path.includes("shellx-release-ui-preview-")
        && preview.path.endsWith("owned-preview.md");
    }
    if (body.clearPreview === true) {
      sessionPreviewVisible = false;
      ownedVideoPreviewActive = false;
      ownedMarkdownPreviewActive = false;
    }
    if (Array.isArray(body.debugAttachPaths)) {
      ownedPendingAttachmentActive = body.debugAttachPaths.some((path) => (
        typeof path === "string"
        && path.includes("shellx-release-ui-attachment-")
        && path.endsWith("owned-attachment.txt")
      ));
    }
    if (Array.isArray(body.debugRemoveAttachmentPaths)) {
      ownedPendingAttachmentActive = false;
    }
    if (body.debugUiConnectionFixture === "disconnected") {
      debugUiConnectionFixture = "disconnected";
    } else if (body.debugUiConnectionFixture === "clear") {
      debugUiConnectionFixture = "clear";
    }
    if (body.debugHashItems === "owned") hashItemsFixtureActive = true;
    if (body.debugHashItems === "clear") hashItemsFixtureActive = false;
    if (body.debugRendererFixture === "clear") {
      ownedRendererEventProjectionActive = false;
      providerActionFixture = "none";
    } else if (body.debugRendererFixture && typeof body.debugRendererFixture === "object"
      && !Array.isArray(body.debugRendererFixture)) {
      const fixture = body.debugRendererFixture as Record<string, unknown>;
      providerActionFixture = fixture.id === "provider-action-lifecycle"
        && fixture.action === "right-rail-connector-action"
        && fixture.cwd === "."
        ? "right-rail-connector-action"
        : "none";
      ownedRendererEventProjectionActive = fixture.id === "event-projections"
        && typeof fixture.attachmentPath === "string"
        && fixture.attachmentPath.includes("shellx-release-ui-events-")
        && fixture.attachmentPath.endsWith("owned-event-attachment.txt")
        && typeof fixture.imagePath === "string"
        && fixture.imagePath.includes("shellx-release-ui-events-")
        && fixture.imagePath.endsWith("owned-event-image.png")
        && typeof fixture.videoPath === "string"
        && fixture.videoPath.includes("shellx-release-ui-events-")
        && fixture.videoPath.endsWith("owned-event-video.mp4");
    }
    if (body.refreshPastChats === true) pastChatVisible = ownedSessionHistoryPresent();
    if (body.cwdPicker && typeof body.cwdPicker === "object" && !Array.isArray(body.cwdPicker)) {
      const picker = body.cwdPicker as Record<string, unknown>;
      if (picker.open === false) cwdPickerMode = "closed";
      else if (picker.label === "Final surface owned empty folder") cwdPickerMode = "empty";
      else if (picker.label === "Final surface owned folder with child") cwdPickerMode = "with-child";
      else cwdPickerMode = "generic";
    }
    if (body.activeTab && typeof body.activeTab === "object" && !Array.isArray(body.activeTab)) {
      const activeTab = body.activeTab as Record<string, unknown>;
      ownedGitRepoActive = typeof activeTab.cwd === "string" && activeTab.cwd.includes("shellx-release-ui-git-");
      ownedFilesPaneActive = typeof activeTab.cwd === "string" && activeTab.cwd.includes("shellx-release-ui-files-");
      ownedActivityBrowserActive = typeof activeTab.cwd === "string"
        && activeTab.cwd.includes("release-activity-workspace")
        && typeof activeTab.sessionId === "string"
        && activeTab.sessionId.startsWith("release_activity_");
      ownedWorkPreviewIssueMounted = typeof activeTab.cwd === "string"
        && activeTab.cwd.includes("ui-work-preview-debug-issue");
      ownedConnectionSelected = activeTab.connectionId === "conn-owned-ui-debug";
    }
    if (body.composerMenu === "branch") branchPickerOpen = ownedGitRepoActive;
    if (body.composerMenu === "connection") connectionPickerOpen = connectionPresets.size > 0;
    if (body.composerMenu === "agent") agentPickerOpen = ownedConnectionSelected;
    if (body.composerMenu === "slash") slashPickerOpen = true;
    if (body.composerMenu === "close") {
      branchPickerOpen = false;
      connectionPickerOpen = false;
      agentPickerOpen = false;
      slashPickerOpen = false;
    }
    if (typeof body.rightTab === "string") {
      if (surface === "browser") browserRightTab = body.rightTab;
      else appRightTab = body.rightTab;
    }
    if (body.debugClipboardFixture === "tasks") tasksPanelOwnedRowActive = true;
    if (body.debugClipboardFixture === "vault-draft") vaultClipboardFixtureActive = true;
    if (body.debugClipboardFixture === "clear") {
      tasksPanelOwnedRowActive = false;
      vaultClipboardFixtureActive = false;
    }
    if (typeof body.debugClick === "string") handleDebugClick(surface, body.debugClick);
    else if (body.debugClick && typeof body.debugClick === "object" && !Array.isArray(body.debugClick)) {
      const click = body.debugClick as Record<string, unknown>;
      if (typeof click.selector === "string") {
        handleDebugClick(surface, click.selector, typeof click.text === "string" ? click.text : undefined);
      }
    }
    if (body.debugInput && typeof body.debugInput === "object" && !Array.isArray(body.debugInput)) {
      handleDebugInput(surface, body.debugInput as Record<string, unknown>);
    }
    if (Array.isArray(body.debugHighlights)) {
      results[surface] = body.debugHighlights.map((entry) => highlightResult(surface, entry as Highlight));
    }
    return json(response, 200, uiState());
  }
  if (request.method === "GET" && request.url === "/state/ui") return json(response, 200, uiState());
  if (request.method === "GET" && request.url === "/fixture-state") {
    return json(response, 200, {
      openModal,
      pluginsFixtureActive,
      pluginsKeyFormEntryId,
      connectorsFixtureActive,
      connectorDraftOpen,
      connectorTargetMode,
      buildPlanFixtureActive,
      shellxagentFixtureActive,
      appBottomTab,
      agentCliSetupFixture: agentCliSetupFixtureMode,
      goalPlanReviewFixture: goalPlanReviewFixtureMode,
      setupGuideDismissed,
      appRightTab,
      tasksPanelOwnedRowActive,
      vaultClipboardFixtureActive,
      settingsTab,
      browserRightTab,
      browserOverlay,
      browserHistoryEntryCount,
      browserWorkflowPreviewVisible,
      browserErrorVisible,
      builtinDocOpen,
      activityEvidenceVisible,
      activityView,
      ownedActivityBrowserActive,
      ownedActivityGraphSelected,
      activitySearchValue,
      findPopoverOpen,
      findSearchValue,
      pastChatVisible,
      pastChatRenaming,
      cwdPickerMode,
      ownedGitRepoActive,
      ownedFilesPaneActive,
      branchPickerOpen,
      connectionPickerOpen,
      connectionPresetCount: connectionPresets.size,
      ownedConnectionSelected,
      ownedConnectionEditorOpen,
      agentPickerOpen,
      slashPickerOpen,
      passwordGeneratorOpen,
      vaultSetupVisible,
      vaultRecoveryKitVisible,
      vaultRowMode,
      vaultRequestCenterOpen,
      vaultAgentRequestActive: vaultAgentRequest?.status === "pending",
      vaultGrantActive: vaultGrant?.approved === true && vaultGrant?.revoked === false,
      vaultKeys: [...vaultEntries].sort(),
      vaultStatus,
      browserSidebarVisible,
      browserTaskActive,
      taskStartCount,
      taskAbortCount,
      ownedProjectDraft,
      ownedProjectRenaming,
      ownedProjectRenameValue,
      ownedProjectDeleteDialog,
      openChatContextMenu,
      pastChatContextMenu,
      sessionRenaming,
      sessionPreviewVisible,
      ownedVideoPreviewActive,
      ownedMarkdownPreviewActive,
      ownedPendingAttachmentActive,
      ownedRendererEventProjectionActive,
      providerActionFixture,
      debugUiConnectionFixture,
      hashItemsFixtureActive,
      composerPromptValue,
      ownedWorkPreviewIssueMounted,
      workPreviewIssueStatus,
      workPreviewIssueTabId,
      workPreviewIssueCwd,
      workPreviewIssueUrl,
      sessionDropdownOpen,
      sessionDeleteDialogOpen,
      bookmarkIds: [...bookmarks.keys()].sort(),
      debugHighlightResultsBySurface: results,
    });
  }
  return json(response, 404, { error: "not found" });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind TCP");
  writeFileSync(stateOut, `${JSON.stringify({ port: address.port })}\n`, "utf8");
});

function highlightResult(surface: Surface, highlight: Highlight): HighlightResult {
  const selector = highlight.selector ?? "";
  const available = surface === "app"
    ? (selector === "[data-debug-id=\"header-theme-toggle\"]" && openModal === "close")
      || (selector === "[data-debug-id=\"left-add-project\"]" && openModal === "close")
      || (openModal === "close" && ownedProjectDraft && (
        selector === "[data-debug-id=\"left-project-row\"]"
        || selector === "[data-debug-id=\"surface-components-leftrail-3\"]"
      ))
      || (openModal === "close" && ownedProjectDraft && ownedProjectRenaming
        && selector === "[data-debug-id=\"left-project-rename-input\"]")
      || (openModal === "close" && ownedProjectDraft && ownedProjectDeleteDialog && (
        selector === "[data-debug-id=\"surface-components-leftrail-19\"]"
        || selector === "[data-debug-id=\"surface-components-leftrail-20\"]"
        || selector === ".proj-delete-actions > button:first-child"
      ))
      || (openModal === "close" && ownedProjectDraft && !ownedProjectRenaming
        && openChatContextMenu
        && selector === "[data-debug-id=\"surface-components-leftrail-15\"]")
      || (openModal === "close" && ownedProjectDraft && !ownedProjectRenaming
        && pastChatVisible && pastChatContextMenu
        && selector === "[data-debug-id=\"surface-components-leftrail-17\"]")
      || (openModal === "close" && sessionRenaming
        && selector === "[data-debug-id=\"session-rename-input\"]")
      || (openModal === "close" && sessionPreviewVisible && !sessionRenaming
        && selector === "[data-debug-id=\"surface-components-sessiontabs-4\"]")
      || (openModal === "close" && sessionPreviewVisible && sessionDropdownOpen
        && selector === "[data-debug-id=\"surface-components-sessiontabs-11\"]")
      || (openModal === "close" && sessionDeleteDialogOpen && (
        selector === "[data-debug-id=\"surface-components-leftrail-24\"]"
        || selector === "[data-debug-id=\"surface-components-leftrail-25\"]"
      ))
      || (openModal === "close" && (
        selector === "[data-debug-id=\"surface-components-rowactions-1\"]"
        || selector === "[data-debug-id=\"surface-components-rowactions-2\"]"
      ))
      || (selector === "[data-debug-id=\"settings-tab-general\"]" && openModal === "settings")
      || (selector === "[data-debug-id=\"shellx-setup-guide\"]" && !setupGuideDismissed)
      || (selector === "[data-debug-id=\"about-full-manual-link\"]" && openModal === "settings" && settingsTab === "about")
      || (selector === "[data-debug-id=\"surface-components-builtindocmodal-4\"]"
        && openModal === "settings" && builtinDocOpen)
      || (selector === "[data-debug-id=\"surface-components-builtindocmodal-5\"]"
        && openModal === "settings" && builtinDocOpen)
      || (selector === "[data-debug-id=\"surface-components-filepreviewmodal-1\"]"
        && openModal === "preview")
      || (openModal === "settings" && shellxagentFixtureActive && new Set([
        "[data-debug-id=\"surface-components-settings-shellxagenttab-1\"]",
        "[data-debug-id=\"surface-components-settings-shellxagenttab-2\"]",
        "[data-debug-id=\"surface-components-settings-shellxagenttab-3\"]",
      ]).has(selector))
      || (openModal === "buildPlanReview" && buildPlanFixtureActive && new Set([
        "[data-debug-id=\"surface-components-buildplanreviewmodal-1\"]",
        "[data-debug-id=\"surface-components-buildplanreviewmodal-4\"]",
        "[data-debug-id=\"surface-components-buildplanreviewmodal-5\"]",
      ]).has(selector))
      || (openModal === "plugins" && pluginsFixtureActive && new Set([
        "[data-marketplace-entry-id='release-owned-recommended']",
        "[data-debug-id=\"plugins-entry-toggle\"]",
        "[data-debug-id=\"surface-components-pluginsmodal-10\"]",
        "[data-debug-id=\"surface-components-pluginsmodal-11\"]",
      ]).has(selector))
      || (openModal === "plugins" && pluginsFixtureActive
        && pluginsKeyFormEntryId === "release-owned-installed-key" && new Set([
          "[data-debug-id=\"plugins-vault-key-input\"]",
          "[data-debug-id=\"surface-components-pluginsmodal-13\"]",
        ]).has(selector))
      || (openModal === "settings" && settingsTab === "connectors" && connectorsFixtureActive
        && selector === "[data-connectors-debug-fixture='owned-safe']")
      || (openModal === "settings" && settingsTab === "connectors" && connectorsFixtureActive
        && selector === "[data-debug-id=\"surface-components-settings-connectorstab-18\"]")
      || (openModal === "settings" && settingsTab === "connectors" && new Set([
        "[data-debug-id=\"surface-components-settings-connectorstab-1\"]",
        "[data-debug-id=\"surface-components-settings-connectorstab-17\"]",
      ]).has(selector))
      || (openModal === "settings" && settingsTab === "connectors" && connectorDraftOpen && new Set([
        "[data-debug-id=\"connector-approval-auto-dispatch\"]",
        "[data-debug-id=\"connector-approval-review-first\"]",
        "[data-debug-id=\"surface-components-settings-connectorstab-3\"]",
        "[data-debug-id=\"surface-components-settings-connectorstab-12\"]",
        "[data-debug-id=\"surface-components-settings-connectorstab-21\"]",
      ]).has(selector))
      || (openModal === "settings" && settingsTab === "connectors" && connectorDraftOpen
        && connectorTargetMode === "fixedTab"
        && selector === "[data-debug-id=\"surface-components-settings-connectorstab-11\"]")
      || (selector === "[data-debug-id=\"surface-components-mediapreview-1\"]"
        && openModal === "preview" && ownedVideoPreviewActive)
      || (openModal === "preview" && ownedMarkdownPreviewActive && (
        selector === "[data-debug-id=\"surface-lib-markdown-links-1\"]"
        || selector === "[data-debug-id=\"surface-lib-markdown-links-2\"]"
      ))
      || (openModal === "assets" && ownedPendingAttachmentActive
        && selector === "[data-debug-id=\"surface-components-attachmentmediaboard-9\"]")
      || (openModal === "close" && appBottomTab === "Chat" && ownedRendererEventProjectionActive
        && new Set([
          "[data-debug-id=\"surface-components-chatoutput-3\"]",
          "[data-debug-id=\"surface-components-chatoutput-4\"]",
          "[data-debug-id=\"surface-components-chatoutput-5\"]",
          "[data-debug-id=\"surface-components-permissionpill-1\"]",
          "[data-debug-id=\"surface-components-permissionpill-3\"]",
        ]).has(selector))
      || (openModal === "assets" && ownedRendererEventProjectionActive && new Set([
        "[data-debug-id=\"surface-components-attachmentmediaboard-12\"]",
        "[data-debug-id=\"surface-components-attachmentmediaboard-14\"]",
        "[data-debug-id=\"surface-components-attachmentmediaboard-18\"]",
        "[data-debug-id=\"surface-components-attachmentmediaboard-19\"]",
      ]).has(selector))
      || (openModal === "close" && debugUiConnectionFixture === "disconnected" && (
        selector === "[data-debug-id=\"debug-api-disconnected\"]"
        || selector === "[data-debug-id=\"debug-api-retry\"]"
      ))
      || (openModal === "close" && appRightTab === "Tooling"
        && providerActionFixture === "right-rail-connector-action"
        && selector === "[data-debug-id=\"surface-components-rightrail-11\"]")
      || (openModal === "close" && hashItemsFixtureActive && composerPromptValue === "#735"
        && selector === "[data-debug-id=\"surface-components-hashautocomplete-1\"]")
      || (openModal === "close" && appBottomTab === "Images" && ownedRendererEventProjectionActive
        && selector === "[data-debug-id=\"surface-components-bottompanel-9\"]")
      || (openModal === "close" && vaultRequestCenterOpen && vaultAgentRequest?.status === "pending" && (
        selector === "[data-debug-id=\"vault-request-center-item\"]"
        || selector === "[data-debug-id^=\"vault-request-action-\"]"
      ))
      || (openModal === "vault" && vaultGrantsTabActive && vaultGrant?.approved === true
        && vaultGrant?.revoked === false
        && selector === "[data-debug-id=\"shellx-vault-grant-row\"]")
      || (openModal === "activity" && activityEvidenceVisible && (
        selector === "[data-debug-id=\"activity-evidence-column-resizer\"]"
        || selector === "[data-debug-id=\"activity-evidence-row-resizer\"]"
        || selector === "[data-debug-id^=\"activity-evidence-section-\"][data-debug-id$=\"-expand\"]"
      ))
      || (openModal === "activity" && ownedActivityBrowserActive && activityView === "graph"
        && selector === "[data-debug-id=\"surface-components-activitybrowsermodal-14\"]")
      || (openModal === "activity" && ownedActivityBrowserActive && activityView === "graph"
        && ownedActivityGraphSelected
        && selector === "[data-debug-id=\"surface-components-activitybrowsermodal-16\"]")
      || (openModal === "activity" && ownedActivityBrowserActive && activityView === "files" && (
        selector === "[data-debug-id=\"surface-components-activitybrowsermodal-17\"]"
        || selector === "[data-debug-id=\"surface-components-activitybrowsermodal-18\"]"
      ))
      || (openModal === "activity" && ownedActivityBrowserActive && activityView === "timeline"
        && selector === "[data-debug-id=\"surface-components-activitybrowsermodal-19\"]")
      || (openModal === "activity" && ownedActivityBrowserActive && activityView === "evidence"
        && selector === "[data-debug-id=\"surface-components-activitybrowsermodal-21\"]")
      || (openModal === "activity" && activitySearchValue.length > 0
        && selector === "[data-debug-id=\"activity-search-clear\"]")
      || (openModal === "close" && findPopoverOpen && findSearchValue.length === 0
        && selector === "[data-debug-id=\"surface-components-findpopover-3\"]")
      || (openModal === "close" && agentCliSetupFixtureMode !== "closed" && new Set([
        "[data-debug-id=\"agent-cli-setup-assistant\"]",
        "[data-debug-id=\"agent-cli-setup-dialog\"]",
        "[data-debug-id=\"surface-components-agentclisetupassistant-11\"]",
        "[data-debug-id=\"surface-components-agentclisetupassistant-5\"]",
      ]).has(selector))
      || (openModal === "close" && agentCliSetupFixtureMode === "confirmation" && new Set([
        "[data-debug-id=\"agent-cli-setup-confirm\"]",
        "[data-debug-id=\"surface-components-agentclisetupassistant-9\"]",
      ]).has(selector))
      || (openModal === "close" && goalPlanReviewFixtureMode !== "closed" && new Set([
        "[data-debug-id=\"surface-components-goalplanreviewmodal-1\"]",
        "[data-debug-id=\"surface-components-goalplanreviewmodal-7\"]",
        "[data-debug-id=\"surface-components-goalplanreviewmodal-9\"]",
      ]).has(selector))
      || (openModal === "close" && goalPlanReviewFixtureMode === "editing"
        && selector === "[data-debug-id=\"surface-components-goalplanreviewmodal-4\"]")
      || (openModal === "close" && appRightTab === "Tooling" && agentCliSetupFixtureMode === "status-card" && new Set([
        "[data-debug-id=\"agent-cli-setup-open-grok\"]",
        "[data-debug-id=\"agent-cli-setup-open-claude-code\"]",
        "[data-debug-id=\"agent-cli-setup-open-codex-cli\"]",
        "[data-debug-id=\"agent-cli-setup-open-antigravity-cli\"]",
        "[data-debug-id=\"agent-cli-setup-open-missing\"]",
      ]).has(selector))
      || (openModal === "close" && findPopoverOpen && findSearchValue === "SHELLX_RELEASE_SESSION_CANARY"
        && selector === "[data-debug-id=\"surface-components-findpopover-4\"]")
      || (openModal === "close" && pastChatVisible && (
        selector === "[data-debug-id=\"left-past-chats-toggle\"]"
        || selector === "[data-debug-id=\"left-past-chat-row\"]"
        || selector.startsWith("[data-debug-id=\"left-past-chat-row\"][data-session-id=\"")
      ))
      || (openModal === "close" && pastChatVisible && pastChatRenaming
        && selector === "[data-debug-id=\"left-chat-rename-input\"]")
      || (openModal === "close" && cwdPickerMode === "empty"
        && selector === "[data-debug-id=\"remote-cwd-parent\"]")
      || (openModal === "close" && cwdPickerMode === "with-child" && (
        selector === "[data-debug-id=\"remote-cwd-parent\"]"
        || selector === "[data-debug-id=\"remote-cwd-folder\"]"
      ))
      || (openModal === "close" && ownedGitRepoActive && branchPickerOpen
        && selector === "[data-debug-id=\"surface-components-branchpicker-1\"]")
      || (openModal === "close" && connectionPickerOpen && connectionPresets.size === 1
        && selector === "[data-debug-id=\"surface-components-connectionpicker-3\"]")
      || (openModal === "close" && ownedConnectionEditorOpen && connectionPresets.size === 1
        && selector === "[data-debug-id=\"connection-agent-cli-setup-open\"]")
      || (openModal === "close" && ownedConnectionSelected && agentPickerOpen
        && selector === "[data-debug-id=\"surface-components-bottompanel-23\"]")
      || (openModal === "close" && slashPickerOpen
        && selector === "[data-debug-id=\"surface-components-bottompanel-24\"]")
      || (openModal === "close" && ownedFilesPaneActive && appRightTab === "Files"
        && selector === "[data-debug-id=\"surface-components-filespane-7\"]")
      || (openModal === "workPreview" && appRightTab === "Preview"
        && ownedWorkPreviewIssueMounted && workPreviewIssueStatus === "running"
        && selector === "[data-debug-id=\"surface-components-workpreviewpanel-16\"]")
      || (openModal === "vault" && passwordGeneratorOpen && (
        selector.includes("vault-password-generator")
        || selector.includes("surface-components-vaultpasswordgenerator-")
      ))
      || (openModal === "vault" && vaultSetupVisible && new Set([
        "[data-debug-id=\"shellx-vault-setup\"]",
        "[data-debug-id=\"shellx-vault-setup-mode\"]",
        "[data-debug-id=\"shellx-vault-master-passphrase\"]",
        "[data-debug-id=\"shellx-vault-confirm-passphrase\"]",
        "[data-debug-id=\"surface-components-settings-vaultsetuppanel-17\"]",
        "[data-debug-id=\"shellx-vault-recovery-confirm\"]",
        "[data-debug-id=\"shellx-vault-remember-device-setup\"]",
      ]).has(selector))
      || (openModal === "vault" && vaultSetupVisible && vaultRecoveryKitVisible
        && selector === "[data-debug-id=\"shellx-vault-recovery-copy\"]")
      || (openModal === "settings" && vaultClipboardFixtureActive && vaultSetupVisible
        && selector === "[data-debug-id=\"vault-profile-collision\"]")
      || (openModal === "vault" && vaultEntries.size > 0 && new Set([
        "[data-debug-id=\"vault-description-inline\"]",
        "[data-debug-id=\"vault-permission-bar\"]",
        "[data-debug-id=\"vault-permission-visible\"]",
        "[data-debug-id=\"vault-permission-userOnly\"]",
        "[data-debug-id=\"vault-permission-browserFillAlways\"]",
        "[data-debug-id=\"vault-permission-toolUseAlways\"]",
        "[data-debug-id=\"vault-resource-section-secrets\"]",
        "[data-debug-id=\"vault-resource-section-profile-cards\"]",
        "[data-debug-id=\"vault-resource-section-agent-wallets\"]",
      ]).has(selector))
      || (openModal === "vault" && vaultEntries.size > 0 && vaultRowMode === "metadata" && new Set([
        "[data-debug-id=\"vault-description-input\"]",
        "[data-debug-id=\"vault-user-only-toggle\"]",
        "[data-debug-id=\"surface-components-settings-vaulttab-18\"]",
      ]).has(selector))
      || (openModal === "vault" && vaultEntries.size > 0 && vaultRowMode === "replace"
        && selector === "[data-debug-id=\"surface-components-settings-vaulttab-22\"]")
      || (openModal === "vault" && vaultStatus.mode === "local" && vaultStatus.unlocked === true
        && vaultStatus.rememberedDeviceEnabled === false && new Set([
          "[data-debug-id=\"shellx-vault-configured-summary\"]",
          "[data-debug-id=\"shellx-vault-remember-passphrase\"]",
          "[data-debug-id=\"shellx-vault-remember-device-enable\"]",
          "[data-debug-id=\"shellx-vault-change-setup\"]",
          "[data-debug-id=\"vault-workspace-lock\"]",
        ]).has(selector))
      || (openModal === "vault" && vaultStatus.mode === "local" && vaultStatus.unlocked === false
        && new Set([
          "[data-debug-id=\"shellx-vault-unlock-form\"]",
          "[data-debug-id=\"shellx-vault-unlock-passphrase\"]",
          "[data-debug-id=\"shellx-vault-unlock\"]",
          "[data-debug-id=\"shellx-vault-remember-device-unlock\"]",
          "[data-debug-id=\"vault-workspace-quick-unlock\"]",
          "[data-debug-id=\"surface-components-vaultpanel-5\"]",
        ]).has(selector))
      || (openModal === "vault" && vaultStatus.mode === "local" && vaultStatus.unlocked === true
        && vaultStatus.rememberedDeviceEnabled === true
        && selector === "[data-debug-id=\"shellx-vault-forget-device\"]")
      || (openModal === "close" && appRightTab === "Tooling" && (
        selector === "[data-debug-id=\"surface-components-rightrail-2\"]"
        || selector === "[data-debug-id=\"surface-components-rightrail-9\"]"
      ))
      || (openModal === "close" && appRightTab === "Tasks" && tasksPanelOwnedRowActive
        && selector === "[data-debug-id=\"surface-components-taskspanel-8\"]")
      || activeSettingsSelector(selector)
    : browserTaskActive && (
      selector === "[data-debug-id^=\"shellx-browser-tab-\"]"
      || (selector === "[data-debug-id^=\"shellx-browser-task-\"]" && browserRightTab === "actions")
      || (selector === "[data-debug-id=\"shellx-browser-options-sidecar\"]" && browserOverlay === "options")
      || (selector === "[data-debug-id=\"shellx-browser-chrome-menu-dock\"]" && browserOverlay === "options")
      || (selector === "[data-debug-id=\"shellx-browser-clear-history\"]"
        && browserOverlay === "history" && browserHistoryEntryCount > 0)
      || (selector === "[data-debug-id^=\"shellx-browser-history-entry-\"]"
        && browserOverlay === "history" && browserHistoryEntryCount > 0)
      || (selector === "[data-debug-id=\"shellx-browser-evidence-empty\"]" && browserRightTab === "evidence")
      || (selector === "[data-debug-id=\"shellx-browser-show-right-sidebar-button\"]" && !browserSidebarVisible)
      || (selector === "[data-debug-id^=\"shellx-browser-bookmark-\"]"
        && browserOverlay === "bookmarks-list"
        && bookmarks.size > 0)
      || (selector === "[data-debug-id='shellx-browser-bookmark-manager-dock']"
        && (browserOverlay === "bookmarks-list" || browserOverlay === "bookmarks-manager"))
      || (selector === "[data-debug-id=\"shellx-browser-workflow-preview\"]"
        && browserWorkflowPreviewVisible && browserOverlay === "bookmarks-manager")
      || (selector === "[data-debug-id=\"shellx-browser-error\"]" && browserErrorVisible)
    );
  return available
    ? { ...highlight, status: "resolved", visibleRect: { width: 160, height: 32 } }
    : { ...highlight, status: "missing", message: `${selector} is outside the prepared fixture` };
}

function activeSettingsSelector(selector: string): boolean {
  if (openModal !== "settings" || !selector.includes("aria-selected='true'")) return false;
  const match = selector.match(/settings-tab-([a-z]+)'\]\[aria-selected/);
  return match?.[1] === settingsTab;
}

function handleDebugClick(surface: Surface, selector: string, text?: string): void {
  if (surface === "app") {
    if (openModal === "vault" && selector === "[data-debug-id='vault-tab-grants']") {
      vaultGrantsTabActive = true;
    }
    if (openModal === "close" && connectionPickerOpen && selector === ".connection-row-main") {
      connectionPickerOpen = false;
      ownedConnectionSelected = true;
    }
    if (openModal === "close" && connectionPickerOpen
      && selector === "[data-debug-id='surface-components-connectionpicker-3'] > button:nth-of-type(2)") {
      connectionPickerOpen = false;
      ownedConnectionEditorOpen = connectionPresets.size === 1;
    }
    if (selector === "[aria-label='Close connection editor']") {
      ownedConnectionEditorOpen = false;
    }
    if (openModal === "close" && selector === "[data-debug-id='left-add-project']") {
      ownedProjectDraft = true;
      ownedProjectRenaming = true;
      ownedProjectRenameValue = "New project";
      ownedProjectDeleteDialog = false;
    }
    if (openModal === "close" && ownedProjectDraft && !ownedProjectRenaming
      && selector === "[aria-label='Delete project']") {
      ownedProjectDeleteDialog = true;
    }
    if (ownedProjectDraft && ownedProjectDeleteDialog
      && selector === ".proj-delete-actions > button:first-child") {
      ownedProjectDraft = false;
      ownedProjectRenaming = false;
      ownedProjectRenameValue = "";
      ownedProjectDeleteDialog = false;
      openChatContextMenu = false;
      pastChatContextMenu = false;
    }
    if (openModal === "close" && selector === "[aria-label='Rename session']") {
      sessionRenaming = true;
    }
    if (openModal === "close" && pastChatVisible
      && selector === "[data-debug-id='left-past-chat-row'] [aria-label='Rename chat']") {
      pastChatRenaming = true;
    }
    if (openModal === "close" && selector === "[aria-label='All sessions']") {
      sessionDropdownOpen = !sessionDropdownOpen;
    }
    if (openModal === "close" && selector === "[aria-label='Delete this session']") {
      sessionDeleteDialogOpen = true;
    }
    if (selector === "[role='alertdialog'] .proj-delete-actions > button:last-child") {
      sessionDeleteDialogOpen = false;
    }
    const tab = selector.match(/settings-tab-([a-z]+)/)?.[1];
    if (openModal === "settings" && tab) settingsTab = tab;
    if (openModal === "settings" && settingsTab === "connectors" && connectorsFixtureActive
      && selector === "[aria-label='Connector editor'] .connector-editor-head > button.settings-pill:not([aria-label])") {
      connectorDraftOpen = true;
      connectorTargetMode = "activeTab";
    }
    if (openModal === "settings" && settingsTab === "connectors" && selector === "[aria-label='Cancel connector draft']") {
      connectorDraftOpen = false;
      connectorTargetMode = "activeTab";
    }
    if (openModal === "settings" && settingsTab === "about"
      && selector === "[title='Read the shellX features overview']") builtinDocOpen = true;
    if (openModal === "activity" && selector === "[data-debug-id='activity-tab-files']") {
      activityView = "files";
      activityEvidenceVisible = false;
    }
    if (openModal === "activity" && selector === "[data-debug-id='activity-tab-graph']") {
      activityView = "graph";
      activityEvidenceVisible = false;
    }
    if (openModal === "activity" && selector === "[data-debug-id='activity-tab-evidence']") {
      activityView = "evidence";
      activityEvidenceVisible = true;
    }
    if (openModal === "activity" && selector === "[data-debug-id='activity-tab-timeline']") {
      activityView = "timeline";
      activityEvidenceVisible = false;
    }
    if (openModal === "activity" && ownedActivityBrowserActive
      && selector === "[data-debug-id='surface-components-activitybrowsermodal-14'][title='src/nested/owned-activity.ts']") {
      ownedActivityGraphSelected = true;
    }
    if (openModal === "plugins" && pluginsFixtureActive
      && selector === "[data-marketplace-entry-id='release-owned-installed-key'] [title='Enter your API key inline']") {
      pluginsKeyFormEntryId = "release-owned-installed-key";
    }
    if (openModal === "plugins" && pluginsFixtureActive
      && selector === "[data-marketplace-entry-id='release-owned-installed-key'] [title='Cancel adding key (clears input)']") {
      pluginsKeyFormEntryId = null;
    }
    if (openModal === "vault" && selector === "[data-debug-id='vault-generate-password']") {
      passwordGeneratorOpen = true;
    }
    if ((openModal === "vault" || (openModal === "settings" && vaultClipboardFixtureActive))
      && selector === "[data-debug-id='vault-tab-setup']") {
      vaultSetupVisible = true;
    }
    if (openModal === "vault" && vaultSetupVisible && selector === "button" && text === "Create recovery kit"
      && vaultMasterPassphrase.length > 0 && vaultMasterPassphrase === vaultConfirmPassphrase) {
      vaultRecoveryKitVisible = true;
    }
    if (openModal === "vault" && selector.startsWith("[aria-label='Edit metadata for ")) {
      vaultRowMode = "metadata";
    }
    if (openModal === "vault" && selector.startsWith("[aria-label='Replace value for ")) {
      vaultRowMode = "replace";
    }
    return;
  }
  if (selector === "[data-debug-id='shellx-browser-options']") browserOverlay = "options";
  else if (selector === "[data-debug-id='shellx-browser-options-close']") browserOverlay = "none";
  else if (selector === "[data-debug-id='shellx-browser-history-menu']") browserOverlay = "history";
  else if (selector === "[data-debug-id='shellx-browser-history-close']") browserOverlay = "none";
  else if (selector === "[data-debug-id='shellx-browser-bookmarks-menu']") browserOverlay = "bookmarks-list";
  else if (selector === "[data-debug-id='shellx-browser-bookmark-manager-toggle']") browserOverlay = "bookmarks-manager";
  else if (selector === "[data-debug-id='shellx-browser-bookmark-manager-close']") browserOverlay = "none";
  else if (selector === "[data-debug-id='shellx-browser-bookmark-final-surface-missing-workflow']"
    && browserOverlay === "bookmarks-list"
    && bookmarks.get("final-surface-missing-workflow")?.agentWorkflow?.recipePath) {
    browserOverlay = "bookmarks-manager";
    browserWorkflowPreviewVisible = true;
    browserErrorVisible = true;
  }
  else if (selector === "[data-debug-id='shellx-browser-reload']") browserErrorVisible = false;
  else if (selector === "[data-debug-id='shellx-browser-toggle-right-sidebar-button']") browserSidebarVisible = false;
  else if (selector === "[data-debug-id='shellx-browser-show-right-sidebar-button']") browserSidebarVisible = true;
}

function handleDebugInput(surface: Surface, input: Record<string, unknown>): void {
  if (surface === "app" && input.selector === "[data-debug-id='composer-prompt']") {
    composerPromptValue = typeof input.value === "string" ? input.value : "";
    return;
  }
  if (surface === "app" && openModal === "settings" && settingsTab === "connectors"
    && connectorsFixtureActive && connectorDraftOpen && input.selector === "#connector-target") {
    connectorTargetMode = input.value === "fixedTab" ? "fixedTab" : "activeTab";
    return;
  }
  if (surface === "app" && input.selector === "[data-debug-id='shellx-vault-master-passphrase']") {
    vaultMasterPassphrase = typeof input.value === "string" ? input.value : "";
    return;
  }
  if (surface === "app" && input.selector === "[data-debug-id='shellx-vault-confirm-passphrase']") {
    vaultConfirmPassphrase = typeof input.value === "string" ? input.value : "";
    return;
  }
  if (surface === "app" && input.selector === "[data-debug-id='session-rename-input']"
    && input.key === "Escape") {
    sessionRenaming = false;
    return;
  }
  if (surface === "app" && input.selector === "[data-debug-id='left-chat-rename-input']"
    && input.key === "Escape") {
    pastChatRenaming = false;
    return;
  }
  if (surface === "app" && ownedProjectDraft && !ownedProjectRenaming
    && input.selector === ".unfiled-row.active > .unfiled-row-main"
    && input.key === "ContextMenu") {
    openChatContextMenu = true;
    return;
  }
  if (surface === "app" && ownedProjectDraft && !ownedProjectRenaming && pastChatVisible
    && input.selector === "[data-debug-id='left-past-chat-row'] > .unfiled-row-main"
    && input.key === "ContextMenu") {
    pastChatContextMenu = true;
    return;
  }
  if (surface === "app" && input.key === "Escape"
    && input.selector === "[role='menu'][aria-label='Move chat to project']") {
    openChatContextMenu = false;
    return;
  }
  if (surface === "app" && input.key === "Escape"
    && input.selector === "[role='menu'][aria-label='Move past chat to project']") {
    pastChatContextMenu = false;
    return;
  }
  if (surface === "app" && ownedProjectDraft
    && input.selector === "[data-debug-id='left-project-rename-input']") {
    ownedProjectRenameValue = typeof input.value === "string" ? input.value : "";
    if (input.key === "Enter") {
      if (ownedProjectRenameValue.trim()) {
        ownedProjectRenaming = false;
      } else {
        ownedProjectDraft = false;
        ownedProjectRenaming = false;
        ownedProjectDeleteDialog = false;
      }
    }
    return;
  }
  if (surface === "app" && input.selector === "[data-debug-id='find-sessions-input']") {
    if (input.key === "Escape") {
      findPopoverOpen = false;
      findSearchValue = "";
    } else {
      findPopoverOpen = true;
      findSearchValue = typeof input.value === "string" ? input.value : "";
    }
    return;
  }
  if (
    surface === "app"
    && openModal === "activity"
    && input.selector === "[data-debug-id='activity-search']"
    && typeof input.value === "string"
  ) {
    activitySearchValue = input.value;
  }
}

function readBookmark(body: Record<string, unknown>): Bookmark {
  if (typeof body.bookmarkId !== "string" || typeof body.label !== "string") {
    throw new Error("bookmarkId and label are required");
  }
  if (body.kind !== "folder" && body.kind !== "link") throw new Error("bookmark kind is invalid");
  return {
    bookmarkId: body.bookmarkId,
    kind: body.kind,
    label: body.label,
    ...(typeof body.url === "string" ? { url: body.url } : {}),
    ...(typeof body.parentId === "string" ? { parentId: body.parentId } : {}),
    ...(body.agentWorkflow && typeof body.agentWorkflow === "object" && !Array.isArray(body.agentWorkflow)
      && typeof (body.agentWorkflow as Record<string, unknown>).recipePath === "string"
      ? {
          agentWorkflow: {
            recipePath: String((body.agentWorkflow as Record<string, unknown>).recipePath),
            ...(typeof (body.agentWorkflow as Record<string, unknown>).goal === "string"
              ? { goal: String((body.agentWorkflow as Record<string, unknown>).goal) }
              : {}),
          },
        }
      : {}),
  };
}

function workPreviewIssueState(tabId: string): Record<string, unknown> {
  if (workPreviewIssueStatus === "idle" || workPreviewIssueTabId !== tabId) {
    return {
      tabId,
      cwd: null,
      kind: null,
      status: "idle",
      url: null,
      command: null,
      taskId: null,
      pid: null,
      startedAtMs: null,
      updatedAtMs: 1,
      viewportHint: null,
      error: null,
      logs: [],
    };
  }
  return {
    tabId,
    cwd: workPreviewIssueCwd,
    kind: "staticHtml",
    status: workPreviewIssueStatus,
    url: workPreviewIssueUrl,
    command: "shellX static file server",
    taskId: null,
    pid: null,
    startedAtMs: 2,
    updatedAtMs: workPreviewIssueStatus === "running" ? 3 : 4,
    viewportHint: null,
    error: null,
    logs: workPreviewIssueStatus === "running"
      ? [
          { t: 2, stream: "system", line: "starting owned Work Preview issue" },
          { t: 3, stream: "system", line: "owned Work Preview issue running" },
        ]
      : [
          { t: 2, stream: "system", line: "starting owned Work Preview issue" },
          { t: 3, stream: "system", line: "owned Work Preview issue running" },
          { t: 4, stream: "system", line: "owned Work Preview issue stopped" },
        ],
  };
}

function uiState(): Record<string, unknown> {
  return {
    openModal,
    bottomTab: appBottomTab,
    agentCliSetupFixture: agentCliSetupFixtureMode,
    goalPlanReviewFixture: goalPlanReviewFixtureMode,
    setupGuideDismissed,
    rightTab: appRightTab,
    activeTabId: "fixture-tab",
    activeTab: {
      tabId: "fixture-tab",
      cwd: "/fixture/project",
      connectionId: null,
      connectionLabel: "Local",
      connectionTransport: "local",
    },
    debugHighlightResults: results.app,
    debugHighlightResultsBySurface: results,
  };
}

function ownedSessionHistoryPresent(): boolean {
  try {
    return readdirSync(join(dirname(tokenFile), "sessions")).some((name) => name.endsWith(".jsonl"));
  } catch {
    return false;
  }
}

function vaultBaselineStatus(): {
  mode: "unconfigured" | "local";
  unlocked: boolean;
  recoveryConfirmed: boolean;
  rememberedDeviceEnabled: boolean;
} {
  return {
    mode: "unconfigured",
    unlocked: false,
    recoveryConfirmed: false,
    rememberedDeviceEnabled: true,
  };
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function requiredArg(name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required`);
  return value;
}
