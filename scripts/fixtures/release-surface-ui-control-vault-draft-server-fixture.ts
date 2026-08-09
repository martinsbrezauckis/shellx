import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const stateOut = requiredArg("--state-out");
const token = requiredArg("--token");
const sessionId = requiredArg("--session-id");
const instanceId = requiredArg("--instance-id");
const processId = Number(requiredArg("--process-id"));
const version = requiredArg("--version");
const sourceCommit = requiredArg("--source-commit");

type FormTab = "profileCard" | "secret" | "stripeAgentWallet";
type Choice = { tab: FormTab; kind: "checkbox" | "select"; value: boolean | string; labels?: Record<string, string> };
type PermissionLevel = "visible" | "userOnly" | "toolUseAlways" | "browserFillAlways";
type FixtureGrant = {
  grantId: string;
  secretRef: string;
  actorScope: string;
  operation: string;
  origin: string;
  createdAtMs: number;
  expiresAtMs: number;
  revoked: boolean;
  approved: boolean;
};

let settingsOpen = false;
let vaultWorkspaceOpen = false;
let settingsTab = "data";
let settingsTabStored: string | null = "data";
let vaultWorkspaceTab = "secrets";
let vaultResourceFormTab: FormTab = "secret";
let vaultPermissionLevel: PermissionLevel = "visible";
let vaultSetupMode: "local" | "external" = "local";
let vaultSetupRememberDevice = false;
let vaultRecoveryKitVisible = false;
let vaultRecoveryImport = false;
let vaultConfigured = false;
let vaultLocked = false;
let vaultConfiguredSetupFormVisible = false;
let vaultUnlockRememberDevice = true;
let vaultRememberedDeviceEnabled = false;
let vaultRecoveryCreateCount = 0;
let vaultRecoveryConfirmCount = 0;
let vaultChangeSetupCount = 0;
let vaultLockCount = 0;
let vaultUnlockCount = 0;
let vaultResetCount = 0;
let vaultGrantsRefreshCount = 0;
let vaultGrantRevokeCount = 0;
let vaultRememberDeviceEnableCount = 0;
let vaultForgetDeviceCount = 0;
let nextGrantId = 1;
const seededSecretRefs = new Set<string>();
const grants: FixtureGrant[] = [];
let renderedGrantIds: string[] = [];
const clickedSelectors: string[] = [];
const textValues = new Map<string, string>();
const choices = new Map<string, Choice>([
  ["[data-debug-id='surface-components-settings-vaulttab-45']", { tab: "profileCard", kind: "checkbox", value: false }],
  ["[data-debug-id='surface-components-settings-vaulttab-48']", {
    tab: "stripeAgentWallet", kind: "select", value: "test", labels: { "Stripe test": "test", "Stripe live": "live" },
  }],
  ["[data-debug-id='surface-components-settings-vaulttab-57']", {
    tab: "stripeAgentWallet", kind: "select", value: "dryRun", labels: { "Dry-run": "dryRun", Active: "active", Frozen: "frozen" },
  }],
  ["[data-debug-id='surface-components-settings-vaulttab-59']", { tab: "stripeAgentWallet", kind: "checkbox", value: false }],
]);

const textTabs = new Map<string, FormTab>([
  ["[data-debug-id='vault-filter-input']", "secret"],
  ["[data-debug-id='vault-secret-key-input']", "secret"],
  ["[data-debug-id='vault-secret-value-input']", "secret"],
  ...[
    "Card label", "Full name", "Email", "Username", "Company", "Role", "Phone",
    "Address line 1", "Address line 2", "City", "Region", "Postal code", "Country",
  ].map((placeholder) => [`[placeholder='${placeholder}']`, "profileCard" as const] as const),
  ...[
    "Wallet label", "Stripe API secret ref", "Webhook signing secret ref", "Stripe account ref",
    "Stripe cardholder ref", "Stripe card ref", "Budget summary", "Allowed origins, comma-separated",
    "Allowed categories, comma-separated",
  ].map((placeholder) => [`[placeholder='${placeholder}']`, "stripeAgentWallet" as const] as const),
]);
const descriptionSelector = "[placeholder='description visible to agents unless marked user-only']";
const permissionLevels = ["visible", "userOnly", "toolUseAlways", "browserFillAlways"] as const;
const vaultSetupModeLocal = "[data-debug-id='shellx-vault-setup-mode'] > button:first-child";
const vaultSetupModeExternal = "[data-debug-id='shellx-vault-setup-mode'] > button:last-child";
const vaultSetupRemember = "[data-debug-id='shellx-vault-remember-device-setup']";
const vaultRecoveryCreate = ".vault-setup-actions > button:first-child";
const vaultRecoveryCopy = "[data-debug-id='shellx-vault-recovery-copy']";
const vaultRecoveryImportSelector = ".vault-recovery-kit .vault-check-row input";
const vaultRecoveryConfirm = "[data-debug-id='shellx-vault-recovery-confirm']";
const vaultConfiguredSummary = "[data-debug-id='shellx-vault-configured-summary']";
const vaultChangeSetup = "[data-debug-id='shellx-vault-change-setup']";
const vaultUnlockForm = "[data-debug-id='shellx-vault-unlock-form']";
const vaultUnlockPassphrase = "[data-debug-id='shellx-vault-unlock-passphrase']";
const vaultUnlockRemember = "[data-debug-id='shellx-vault-remember-device-unlock']";
const vaultUnlock = "[data-debug-id='shellx-vault-unlock']";
const vaultRememberPassphrase = "[data-debug-id='shellx-vault-remember-passphrase']";
const vaultRememberDeviceEnable = "[data-debug-id='shellx-vault-remember-device-enable']";
const vaultForgetDevice = "[data-debug-id='shellx-vault-forget-device']";
const vaultWorkspaceModal = "[data-debug-id='vault-workspace-modal']";
const vaultWorkspaceLock = "[data-debug-id='vault-workspace-lock']";
const vaultWorkspaceQuickUnlock = "[data-debug-id='vault-workspace-quick-unlock']";
const vaultWorkspacePassphrase = "[aria-label='Vault master passphrase']";
const vaultWorkspaceUnlock = "[data-debug-id='surface-components-vaultpanel-5']";
const vaultGrantsTab = "[data-debug-id='vault-tab-grants']";
const vaultGrantsPanel = "[data-debug-id='shellx-vault-grants']";
const vaultGrantRow = "[data-debug-id='shellx-vault-grant-row']";
const vaultGrantsRefresh = ".vault-grants-panel .vault-panel-head > button.settings-pill";
const vaultGrantRevoke = `${vaultGrantRow} > button.settings-pill`;
const vaultMasterPassphrase = "[data-debug-id='shellx-vault-master-passphrase']";
const vaultConfirmPassphrase = "[data-debug-id='shellx-vault-confirm-passphrase']";
const vaultSetupTextSelectors = new Set([
  "[placeholder='Server URL']",
  "[placeholder='Repo']",
  "[placeholder='Access token']",
  "[data-debug-id='shellx-vault-master-passphrase']",
  "[data-debug-id='shellx-vault-confirm-passphrase']",
]);
const externalVaultSetupTextSelectors = new Set([
  "[placeholder='Server URL']",
  "[placeholder='Repo']",
  "[placeholder='Access token']",
]);

const candidate = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      return json(response, 200, {
        ok: true,
        processId,
        instanceId,
        appVersion: version,
        buildCommit: sourceCommit,
        debugApiPort: address(candidate).port,
      });
    }
    if (request.headers.authorization !== `Bearer ${token}`) return json(response, 401, { error: "unauthorized" });
    if (request.method === "GET" && request.url === "/state/ui") {
      return json(response, 200, { settingsOpen, settingsTab });
    }
    if (request.method === "GET" && request.url === "/browser/state") {
      return json(response, 200, { profiles: [], tabs: [], tasks: [], windowOpen: false });
    }
    if (request.method === "GET" && request.url === "/vault/status") {
      return json(response, 200, vaultStatus());
    }
    if (request.method === "GET" && request.url === "/vault/grants") {
      return json(response, 200, { grants });
    }
    if (request.method === "POST" && request.url === "/vault/e2e/seed-secret") {
      const body = await requestJson(request);
      if (typeof body.secretRef !== "string" || !body.secretRef
        || typeof body.value !== "string" || !body.value || seededSecretRefs.has(body.secretRef)) {
        return json(response, 400, { error: "invalid owned Vault grant seed" });
      }
      seededSecretRefs.add(body.secretRef);
      vaultConfigured = true;
      vaultLocked = false;
      return json(response, 200, {
        ok: true,
        secretRef: body.secretRef,
        secretPresent: true,
        secretExposed: false,
        receipt: { action: "vaultE2eSecretSeeded", secretExposed: false },
      });
    }
    if (request.method === "POST" && request.url === "/vault/e2e/approve-grant") {
      const body = await requestJson(request);
      const actorScope = body.actorScope as Record<string, unknown> | undefined;
      if (typeof body.secretRef !== "string" || !seededSecretRefs.has(body.secretRef)
        || body.operation !== "fill" || !Number.isSafeInteger(body.expiresAtMs)
        || actorScope?.kind !== "allShellxAgents" || body.origin !== "https://example.com") {
        return json(response, 400, { error: "invalid owned Vault grant approval" });
      }
      const grant: FixtureGrant = {
        grantId: `vault-grant-owned-${nextGrantId++}`,
        secretRef: body.secretRef,
        actorScope: "allShellxAgents",
        operation: "Fill",
        origin: "https://example.com",
        createdAtMs: Date.now(),
        expiresAtMs: Number(body.expiresAtMs),
        revoked: false,
        approved: true,
      };
      grants.push(grant);
      return json(response, 200, {
        ok: true,
        grant,
        secretExposed: false,
        receipt: { action: "vaultE2eGrantApproved", secretExposed: false },
      });
    }
    if (request.method === "POST" && request.url === "/vault/lock") {
      await requestJson(request);
      if (!vaultConfigured) return json(response, 409, { error: "Vault is not configured" });
      vaultLocked = true;
      vaultLockCount += 1;
      setTextValue(vaultUnlockPassphrase, "");
      setTextValue(vaultRememberPassphrase, "");
      return json(response, 200, { unlocked: false, rememberedDeviceEnabled: vaultRememberedDeviceEnabled });
    }
    if (request.method === "POST" && request.url === "/vault/e2e/reset") {
      await requestJson(request);
      vaultRecoveryKitVisible = false;
      vaultRecoveryImport = false;
      vaultConfigured = false;
      vaultLocked = false;
      vaultConfiguredSetupFormVisible = false;
      vaultUnlockRememberDevice = true;
      vaultRememberedDeviceEnabled = false;
      seededSecretRefs.clear();
      grants.length = 0;
      renderedGrantIds = [];
      vaultResetCount += 1;
      setTextValue(vaultMasterPassphrase, "");
      setTextValue(vaultConfirmPassphrase, "");
      setTextValue(vaultUnlockPassphrase, "");
      setTextValue(vaultWorkspacePassphrase, "");
      setTextValue(vaultRememberPassphrase, "");
      return json(response, 200, { ok: true, receipt: { action: "vaultE2eReset", secretExposed: false } });
    }
    if (request.method === "POST" && request.url === "/state/ui") {
      const body = await requestJson(request);
      if (body.openModal === "settings") {
        settingsOpen = true;
        vaultWorkspaceOpen = false;
      }
      if (body.openModal === "vault") {
        settingsOpen = false;
        vaultWorkspaceOpen = true;
      }
      if (body.openModal === "close") {
        settingsOpen = false;
        vaultWorkspaceOpen = false;
      }
      return json(response, 200, { ok: true });
    }
    if (request.method === "GET" && request.url === "/audit") {
      return json(response, 200, {
        settingsOpen,
        vaultWorkspaceOpen,
        settingsTab,
        settingsTabStored,
        vaultWorkspaceTab,
        vaultResourceFormTab,
        vaultSetupMode,
        vaultSetupRememberDevice,
        vaultRecoveryKitVisible,
        vaultRecoveryImport,
        vaultConfigured,
        vaultLocked,
        vaultConfiguredSetupFormVisible,
        vaultUnlockRememberDevice,
        vaultRememberedDeviceEnabled,
        vaultRecoveryCreateCount,
        vaultRecoveryConfirmCount,
        vaultChangeSetupCount,
        vaultLockCount,
        vaultUnlockCount,
        vaultResetCount,
        vaultGrantsRefreshCount,
        vaultGrantRevokeCount,
        vaultRememberDeviceEnableCount,
        vaultForgetDeviceCount,
        seededSecretRefs: [...seededSecretRefs].sort(),
        grants,
        renderedGrantIds,
        textValues: Object.fromEntries(textValues),
        choices: {
          ...Object.fromEntries([...choices].map(([selector, choice]) => [selector, choice.value])),
          ...Object.fromEntries(permissionLevels.map((level) => [permissionSelector(level), vaultPermissionLevel === level])),
        },
        clickedSelectors,
        forbiddenCredentialClicks: clickedSelectors.filter((selector) => (
          /save/i.test(selector)
          || selector === vaultRecoveryCopy
          || selector.includes("keyfile")
        )),
      });
    }
    return json(response, 404, { error: "not found" });
  } catch (error) {
    return json(response, 500, { error: errorText(error) });
  }
});

const webdriver = createServer(async (request, response) => {
  try {
    const path = request.url ?? "";
    const prefix = `/session/${encodeURIComponent(sessionId)}`;
    if (!path.startsWith(prefix)) return webdriverError(response, 404, "invalid session id", "unknown fixture session");
    if (request.method === "GET" && path === `${prefix}/window`) return webdriverValue(response, "main-window");
    if (request.method === "GET" && path === `${prefix}/window/handles`) return webdriverValue(response, ["main-window"]);
    if (request.method === "GET" && path === `${prefix}/title`) return webdriverValue(response, "ShellX");
    if (request.method === "POST" && path === `${prefix}/execute/sync`) {
      const body = await requestJson(request);
      const script = typeof body.script === "string" ? body.script : "";
      const scriptArgs = Array.isArray(body.args) ? body.args : [];
      if (script.includes("SHELLX_BOUNDED_ELEMENT_OBSERVATION")
        && typeof scriptArgs[0] === "string" && Array.isArray(scriptArgs[1])) {
        const selector = scriptArgs[0];
        const requested = scriptArgs[1].filter((field): field is string => typeof field === "string");
        const observation: Record<string, unknown> = {};
        const settings = selector.match(/^\[data-debug-id='settings-tab-([^']+)'\]$/)?.[1];
        if (settings && requested.includes("selected")) observation.selected = settingsTab === settings;
        if ((selector === vaultSetupModeLocal || selector === vaultSetupModeExternal)
          && requested.includes("pressed")) {
          observation.pressed = vaultSetupMode === (selector === vaultSetupModeLocal ? "local" : "external");
        }
        if ((selector === vaultSetupRemember || selector === vaultRecoveryImportSelector || selector === vaultUnlockRemember)
          && requested.includes("checked")) {
          observation.checked = selector === vaultSetupRemember
            ? vaultSetupRememberDevice
            : selector === vaultRecoveryImportSelector
              ? vaultRecoveryImport
              : vaultUnlockRememberDevice;
        }
        const choice = choices.get(selector);
        if (choice?.kind === "checkbox" && requested.includes("checked")) observation.checked = choice.value;
        if (choice?.kind === "select" && requested.includes("value")) observation.value = choice.value;
        const permission = permissionLevelForSelector(selector);
        if (permission && requested.includes("pressed")) observation.pressed = vaultPermissionLevel === permission;
        if (isText(selector) && requested.includes("nonempty")) observation.nonempty = textValue(selector).length > 0;
        if (selector === vaultGrantsPanel && requested.includes("title")) {
          const active = renderedGrantRows().length;
          observation.title = `Vault grants state: active=${active}; revocable=${active > 0 ? "yes" : "no"}`;
        }
        const present = displayed(selector);
        return webdriverValue(response, { present, visible: present, observation: present ? observation : {} });
      }
      return webdriverError(response, 400, "javascript error", "unsupported fixture script");
    }
    if (request.method === "POST" && path === `${prefix}/element`) {
      const body = await requestJson(request);
      const selector = typeof body.value === "string" ? body.value : "";
      return displayed(selector)
        ? webdriverValue(response, element(selector))
        : webdriverError(response, 404, "no such element", `fixture does not expose ${selector}`);
    }
    const displayedMatch = path.match(new RegExp(`^${escapeRegex(prefix)}/element/([^/]+)/displayed$`));
    if (request.method === "GET" && displayedMatch) {
      return webdriverValue(response, displayed(elementSelector(displayedMatch[1]!)));
    }
    const clearMatch = path.match(new RegExp(`^${escapeRegex(prefix)}/element/([^/]+)/clear$`));
    if (request.method === "POST" && clearMatch) {
      const selector = elementSelector(clearMatch[1]!);
      if (!displayed(selector) || !isText(selector)) {
        return webdriverError(response, 400, "invalid element state", "fixture element is not clearable");
      }
      setTextValue(selector, "");
      return webdriverValue(response, null);
    }
    const valueMatch = path.match(new RegExp(`^${escapeRegex(prefix)}/element/([^/]+)/value$`));
    if (request.method === "POST" && valueMatch) {
      const selector = elementSelector(valueMatch[1]!);
      if (!displayed(selector)) return webdriverError(response, 404, "stale element reference", "fixture element is not writable");
      const body = await requestJson(request);
      if (typeof body.text !== "string") return webdriverError(response, 400, "invalid argument", "text is required");
      const choice = choices.get(selector);
      if (choice?.kind === "select") {
        const next = choice.labels?.[body.text];
        if (!next) return webdriverError(response, 400, "invalid argument", "unknown select option");
        choice.value = next;
      } else if (isText(selector)) {
        setTextValue(selector, textValue(selector) + body.text);
      } else {
        return webdriverError(response, 400, "invalid argument", "fixture element is not writable");
      }
      return webdriverValue(response, null);
    }
    const clickMatch = path.match(new RegExp(`^${escapeRegex(prefix)}/element/([^/]+)/click$`));
    if (request.method === "POST" && clickMatch) {
      const selector = elementSelector(clickMatch[1]!);
      if (!displayed(selector)) return webdriverError(response, 404, "stale element reference", "fixture element is not clickable");
      const settings = selector.match(/^\[data-debug-id='settings-tab-([^']+)'\]$/)?.[1];
      const resource = selector.match(/^\[data-debug-id='vault-resource-form-tab-([^']+)'\]$/)?.[1] as FormTab | undefined;
      const choice = choices.get(selector);
      const permission = permissionLevelForSelector(selector);
      if (settings) {
        settingsTab = settings;
        settingsTabStored = settings;
      } else if (selector === "[data-debug-id='vault-tab-secrets']") {
        vaultWorkspaceTab = "secrets";
      } else if (selector === "[data-debug-id='vault-tab-setup']") {
        vaultWorkspaceTab = "setup";
      } else if (selector === vaultGrantsTab) {
        vaultWorkspaceTab = "grants";
        renderedGrantIds = activeGrantRows().map((grant) => grant.grantId);
      } else if (selector === vaultGrantsRefresh) {
        renderedGrantIds = activeGrantRows().map((grant) => grant.grantId);
        vaultGrantsRefreshCount += 1;
      } else if (selector === vaultGrantRevoke) {
        const grant = renderedGrantRows()[0];
        if (!grant) {
          return webdriverError(response, 400, "invalid element state", "no active owned Vault grant is rendered");
        }
        grant.revoked = true;
        renderedGrantIds = activeGrantRows().map((row) => row.grantId);
        vaultGrantRevokeCount += 1;
      } else if (selector === vaultSetupModeLocal || selector === vaultSetupModeExternal) {
        vaultSetupMode = selector === vaultSetupModeLocal ? "local" : "external";
      } else if (selector === vaultSetupRemember) {
        vaultSetupRememberDevice = !vaultSetupRememberDevice;
      } else if (selector === vaultRecoveryCreate) {
        const master = textValue(vaultMasterPassphrase);
        const confirmation = textValue(vaultConfirmPassphrase);
        if (!master || master !== confirmation) {
          return webdriverError(response, 400, "invalid element state", "Vault recovery passphrases do not match");
        }
        vaultRecoveryKitVisible = true;
        vaultRecoveryCreateCount += 1;
        setTextValue(vaultMasterPassphrase, "");
        setTextValue(vaultConfirmPassphrase, "");
      } else if (selector === vaultRecoveryImportSelector) {
        vaultRecoveryImport = !vaultRecoveryImport;
      } else if (selector === vaultRecoveryConfirm) {
        if (!vaultRecoveryKitVisible) {
          return webdriverError(response, 400, "invalid element state", "Vault recovery kit is not ready");
        }
        vaultRecoveryKitVisible = false;
        vaultConfigured = true;
        vaultLocked = false;
        vaultConfiguredSetupFormVisible = false;
        vaultRecoveryConfirmCount += 1;
      } else if (selector === vaultChangeSetup) {
        if (!vaultConfigured) {
          return webdriverError(response, 400, "invalid element state", "Vault is not configured");
        }
        vaultConfiguredSetupFormVisible = true;
        vaultChangeSetupCount += 1;
      } else if (selector === vaultUnlockRemember) {
        vaultUnlockRememberDevice = !vaultUnlockRememberDevice;
      } else if (selector === vaultUnlock) {
        if (!vaultConfigured || !vaultLocked || textValue(vaultUnlockPassphrase) !== "ShellX-Release-UI-Vault-Passphrase-035") {
          return webdriverError(response, 400, "invalid element state", "Vault unlock fixture state is invalid");
        }
        vaultLocked = false;
        vaultUnlockCount += 1;
        setTextValue(vaultUnlockPassphrase, "");
      } else if (selector === vaultRememberDeviceEnable) {
        if (!vaultConfigured || vaultLocked || textValue(vaultRememberPassphrase) !== "ShellX-Release-UI-Vault-Passphrase-035") {
          return webdriverError(response, 400, "invalid element state", "Vault remember-device fixture state is invalid");
        }
        vaultRememberedDeviceEnabled = true;
        vaultRememberDeviceEnableCount += 1;
        setTextValue(vaultRememberPassphrase, "");
      } else if (selector === vaultForgetDevice) {
        if (!vaultConfigured || vaultLocked || !vaultRememberedDeviceEnabled) {
          return webdriverError(response, 400, "invalid element state", "Vault forget-device fixture state is invalid");
        }
        vaultRememberedDeviceEnabled = false;
        vaultForgetDeviceCount += 1;
      } else if (selector === vaultWorkspaceLock) {
        if (!vaultConfigured || vaultLocked) {
          return webdriverError(response, 400, "invalid element state", "Vault workspace is not unlockable");
        }
        vaultLocked = true;
        vaultLockCount += 1;
        setTextValue(vaultWorkspacePassphrase, "");
      } else if (selector === vaultWorkspaceUnlock) {
        if (!vaultConfigured || !vaultLocked || textValue(vaultWorkspacePassphrase) !== "ShellX-Release-UI-Vault-Passphrase-035") {
          return webdriverError(response, 400, "invalid element state", "Vault workspace unlock fixture state is invalid");
        }
        vaultLocked = false;
        vaultUnlockCount += 1;
        setTextValue(vaultWorkspacePassphrase, "");
      } else if (resource && ["secret", "profileCard", "stripeAgentWallet"].includes(resource)) {
        vaultResourceFormTab = resource;
      } else if (choice?.kind === "checkbox") {
        choice.value = !choice.value;
      } else if (permission) {
        vaultPermissionLevel = permission;
      } else {
        return webdriverError(response, 400, "element not interactable", "unsupported fixture control");
      }
      clickedSelectors.push(selector);
      return webdriverValue(response, null);
    }
    return webdriverError(response, 404, "unknown command", `${request.method} ${path}`);
  } catch (error) {
    return webdriverError(response, 500, "unknown error", errorText(error));
  }
});

function displayed(selector: string): boolean {
  if (selector === vaultWorkspaceModal) return vaultWorkspaceOpen;
  if (selector === vaultWorkspaceLock) return vaultWorkspaceOpen && vaultConfigured && !vaultLocked;
  if (selector === vaultWorkspaceQuickUnlock || selector === vaultWorkspacePassphrase || selector === vaultWorkspaceUnlock) {
    return vaultWorkspaceOpen && vaultConfigured && vaultLocked;
  }
  if (selector === "[role='dialog'][aria-label='Settings']") return settingsOpen;
  const selectedSettings = selector.match(/^\[data-debug-id='settings-tab-([^']+)'\]\[aria-selected='true'\]$/)?.[1];
  const settings = selector.match(/^\[data-debug-id='settings-tab-([^']+)'\]$/)?.[1];
  if (selectedSettings) return settingsOpen && settingsTab === selectedSettings;
  if (settings) return settingsOpen;
  if (selector === "[data-debug-id='vault-tab-secrets']") return settingsOpen && settingsTab === "vault";
  if (selector === vaultGrantsTab) return settingsOpen && settingsTab === "vault";
  if (selector === "[data-debug-id='vault-tab-setup']") return settingsOpen && settingsTab === "vault";
  if (selector === vaultGrantsPanel || selector === vaultGrantsRefresh) return vaultGrantsVisible();
  if (selector === vaultGrantRow || selector === vaultGrantRevoke) {
    return vaultGrantsVisible() && renderedGrantRows().length > 0;
  }
  if (selector === vaultSetupModeLocal || selector === vaultSetupModeExternal || selector === vaultSetupRemember) {
    return vaultSetupVisible();
  }
  if (selector === vaultRecoveryCreate) {
    return vaultSetupVisible() && vaultSetupMode === "local" && (!vaultConfigured || vaultConfiguredSetupFormVisible);
  }
  if (selector === vaultRecoveryCopy) return vaultSetupVisible() && vaultRecoveryKitVisible;
  if (selector === vaultRecoveryImportSelector) return vaultSetupVisible() && vaultRecoveryKitVisible;
  if (selector === vaultRecoveryConfirm) return vaultSetupVisible() && (!vaultConfigured || vaultConfiguredSetupFormVisible);
  if (selector === vaultConfiguredSummary) return vaultSetupVisible() && vaultConfigured && !vaultConfiguredSetupFormVisible;
  if (selector === vaultChangeSetup) return vaultSetupVisible() && vaultConfigured && !vaultConfiguredSetupFormVisible;
  if (selector === vaultUnlockForm || selector === vaultUnlockPassphrase
    || selector === vaultUnlockRemember || selector === vaultUnlock) {
    return vaultSetupVisible() && vaultConfigured && vaultLocked && !vaultConfiguredSetupFormVisible;
  }
  if (selector === vaultRememberPassphrase || selector === vaultRememberDeviceEnable) {
    return vaultSetupVisible() && vaultConfigured && !vaultLocked && !vaultConfiguredSetupFormVisible
      && !vaultRememberedDeviceEnabled;
  }
  if (selector === vaultForgetDevice) {
    return vaultSetupVisible() && vaultConfigured && !vaultLocked && !vaultConfiguredSetupFormVisible
      && vaultRememberedDeviceEnabled;
  }
  if (vaultSetupTextSelectors.has(selector)) {
    return vaultSetupVisible()
      && (!vaultConfigured || vaultConfiguredSetupFormVisible)
      && (!externalVaultSetupTextSelectors.has(selector) || vaultSetupMode === "external");
  }
  const selectedResource = selector.match(/^\[data-debug-id='vault-resource-form-tab-([^']+)'\]\.active\[aria-selected='true'\]$/)?.[1];
  const resource = selector.match(/^\[data-debug-id='vault-resource-form-tab-([^']+)'\]$/)?.[1];
  if (selectedResource) return vaultOwnerVisible() && vaultResourceFormTab === selectedResource;
  if (resource) return vaultOwnerVisible();
  const choice = choices.get(selector);
  if (choice) return vaultOwnerVisible() && vaultResourceFormTab === choice.tab;
  if (permissionLevelForSelector(selector)) return vaultOwnerVisible() && vaultResourceFormTab === "secret";
  const textTab = textTabs.get(selector);
  if (textTab) return vaultOwnerVisible() && vaultResourceFormTab === textTab;
  if (selector === descriptionSelector) return vaultOwnerVisible() && vaultResourceFormTab !== "secret";
  return false;
}

function vaultOwnerVisible(): boolean {
  return settingsOpen && settingsTab === "vault" && vaultWorkspaceTab === "secrets";
}

function vaultSetupVisible(): boolean {
  return settingsOpen && settingsTab === "vault" && vaultWorkspaceTab === "setup";
}

function vaultGrantsVisible(): boolean {
  return settingsOpen && settingsTab === "vault" && vaultWorkspaceTab === "grants";
}

function activeGrantRows(): FixtureGrant[] {
  const now = Date.now();
  return grants.filter((grant) => (
    grant.approved && !grant.revoked && grant.expiresAtMs > now
  ));
}

function renderedGrantRows(): FixtureGrant[] {
  const rendered = new Set(renderedGrantIds);
  return activeGrantRows().filter((grant) => rendered.has(grant.grantId));
}

function isText(selector: string): boolean {
  return textTabs.has(selector) || selector === descriptionSelector
    || vaultSetupTextSelectors.has(selector) || selector === vaultUnlockPassphrase
    || selector === vaultWorkspacePassphrase || selector === vaultRememberPassphrase;
}

function textKey(selector: string): string {
  if (selector === vaultUnlockPassphrase) return `unlock\0${selector}`;
  if (selector === vaultWorkspacePassphrase) return `workspace\0${selector}`;
  if (selector === vaultRememberPassphrase) return `remember\0${selector}`;
  if (vaultSetupTextSelectors.has(selector)) return `setup\0${selector}`;
  return `${vaultResourceFormTab}\0${selector}`;
}

function textValue(selector: string): string {
  return textValues.get(textKey(selector)) ?? "";
}

function setTextValue(selector: string, value: string): void {
  textValues.set(textKey(selector), value);
}

function vaultStatus(): Record<string, unknown> {
  return vaultConfigured
    ? { mode: "local", unlocked: !vaultLocked, recoveryConfirmed: true, rememberedDeviceEnabled: vaultRememberedDeviceEnabled }
    : { mode: "unconfigured", unlocked: false, recoveryConfirmed: false, rememberedDeviceEnabled: false };
}

function permissionSelector(level: PermissionLevel): string {
  return `[data-debug-id='vault-permission-${level}']`;
}

function permissionLevelForSelector(selector: string): PermissionLevel | null {
  return permissionLevels.find((level) => permissionSelector(level) === selector) ?? null;
}

candidate.listen(0, "127.0.0.1", () => {
  webdriver.listen(0, "127.0.0.1", () => {
    writeFileSync(stateOut, `${JSON.stringify({
      candidatePort: address(candidate).port,
      webdriverPort: address(webdriver).port,
    })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => candidate.close(() => webdriver.close(() => process.exit(0))));
}

function element(selector: string): Record<string, string> {
  return { "element-6066-11e4-a52e-4f735466cecf": `selector:${Buffer.from(selector).toString("base64url")}` };
}

function elementSelector(value: string): string {
  const id = decodeURIComponent(value);
  if (!id.startsWith("selector:")) throw new Error("fixture element id is invalid");
  return Buffer.from(id.slice("selector:".length), "base64url").toString("utf8");
}

function address(server: typeof candidate): { port: number } {
  const value = server.address();
  if (!value || typeof value === "string") throw new Error("fixture server is not listening");
  return { port: value.port };
}

async function requestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

function webdriverValue(response: ServerResponse, value: unknown): void {
  json(response, 200, { value });
}

function webdriverError(response: ServerResponse, status: number, error: string, message: string): void {
  json(response, status, { value: { error, message, stacktrace: "" } });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requiredArg(name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}
