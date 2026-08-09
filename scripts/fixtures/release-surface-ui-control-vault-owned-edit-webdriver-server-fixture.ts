import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";

type VaultEntry = { key: string; description: string | null; userOnly: boolean; resourceKind?: string };
type VaultStoredEntry = VaultEntry & { value: string };

const args = process.argv.slice(2);
const token = readFileSync(requiredArg(args, "--token-file"), "utf8").trim();
const statePath = requiredArg(args, "--state-out");
const sessionId = requiredArg(args, "--session-id");
const instanceId = requiredArg(args, "--instance-id");
const processId = Number(requiredArg(args, "--process-id"));
const version = requiredArg(args, "--version");
const sourceCommit = requiredArg(args, "--source-commit");
const ownedKey = "release-surface-ui-owned-secret";
const ownedProfileKey = "profile-cards/release-ui-owned-profile";
const ownedWalletKey = "agent-wallets/release-ui-owned-wallet";
const settingsDialog = "[role='dialog'][aria-label='Settings']";
const settingsVaultTab = "[data-debug-id='settings-tab-vault']";
const vaultSecretsTab = "[data-debug-id='vault-tab-secrets']";
const reveal = `[aria-label='Reveal value for ${ownedKey}']`;
const hide = `[aria-label='Hide value for ${ownedKey}']`;
const revealed = `[aria-label='Revealed value for ${ownedKey}']`;
const inlineHide = ".vault-row-reveal [title='Hide value']";
const revealMarker = "[data-debug-id='vault-row-reveal'][data-shellx-sensitive='true']";
const replace = `[aria-label='Replace value for ${ownedKey}']`;
const replaceInput = `[aria-label='New value for ${ownedKey}']`;
const replaceGenerate = ".vault-row-edit [title='Generate a strong replacement']";
const replaceSave = ".vault-row-edit input[type='password'] ~ button[type='submit']";
const replaceCancel = "[data-debug-id='surface-components-settings-vaulttab-22']";
const metadata = `[aria-label='Edit metadata for ${ownedKey}']`;
const metadataDescription = `[aria-label='Description for ${ownedKey}']`;
const metadataUserOnly = ".vault-row-edit [data-debug-id='vault-user-only-toggle']";
const metadataSave = ".vault-row-edit textarea ~ button[type='submit']";
const metadataCancel = "[data-debug-id='surface-components-settings-vaulttab-18']";
const newDescription = "[aria-label='New secret description']";
const newUserOnly = "[data-debug-id='vault-secret-form'] [data-debug-id='vault-user-only-toggle']";
const newKey = "[aria-label='New secret key name']";
const newValue = "[aria-label='New secret value']";
const newValueReveal = ":is([aria-label='Hide generated secret value'],[aria-label='Reveal generated secret value'])";
const newValueHide = "[aria-label='Hide generated secret value']";
const newValueShow = "[aria-label='Reveal generated secret value']";
const newGeneratorOpen = "[data-debug-id='vault-generate-password']";
const newSecretSave = "[data-debug-id='surface-components-settings-vaulttab-30']";
const newCopyEnabled = "[title='Copy without revealing']:not([disabled])";
const generator = "[data-debug-id='vault-password-generator']";
const generatorReveal = "[aria-label='Reveal generated password']";
const generatorHide = "[aria-label='Hide generated password']";
const generatorRegenerate = "[data-debug-id='vault-password-generator-regenerate']";
const generatorUse = "[data-debug-id='vault-password-generator-use']";
const generatorSave = "[data-debug-id='vault-password-generator-save']";
const generatorDelete = ".vault-password-actions > button:last-child";
const ownedDelete = `[aria-label='Delete ${ownedKey}']`;
const ownedConfirmDelete = `[aria-label='Confirm delete ${ownedKey}']`;
const profileTab = "[data-debug-id='vault-resource-form-tab-profileCard']";
const profileLabel = "[placeholder='Card label']";
const profileSave = "[data-debug-id='vault-profile-card-form'] button[type='submit']";
const walletTab = "[data-debug-id='vault-resource-form-tab-stripeAgentWallet']";
const walletLabel = "[placeholder='Wallet label']";
const walletSave = "[data-debug-id='vault-agent-wallet-form'] button[type='submit']";
const reload = "[title='Reload key list']";
const dismiss = "[aria-label='Dismiss notification']";

const vault = new Map<string, VaultStoredEntry>([[
  "fixture/baseline",
  {
    key: "fixture/baseline",
    value: "fixture baseline material",
    description: "Fixture baseline entry",
    userOnly: true,
  },
]]);
let renderedKeys: string[] = [];
let settingsOpen = false;
let settingsTab = "general";
let revealedOpen = false;
let replacing = false;
let replacementDraft = "";
let editingMetadata = false;
let metadataDescriptionDraft = "";
let metadataUserOnlyDraft = false;
let newDescriptionDraft = "";
let newUserOnlyDraft = false;
let newKeyDraft = "";
let newValueDraft = "";
let newValueVisible = false;
let resourceFormTab = "secret";
let generatorOpen = false;
let generatorRevealed = false;
let generatorGenerationCount = 0;
let generatorUseCount = 0;
let generatorSaveCount = 0;
let generatorDeleteCount = 0;
let profileLabelDraft = "";
let walletLabelDraft = "";
let ownedDeleteArmed = false;
let ownedDeleteCount = 0;
let ownedResourceSaveCount = 0;
let noticeVisible = false;
let refreshTransitions = 0;
let revealTransitions = 0;
let replacementSaves = 0;
let metadataSaves = 0;
let secretExposureCount = 0;
const clickedSelectors: string[] = [];
const elementSelectors = new Map<string, string>();
let nextElementId = 1;

const candidate = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!authorized(request)) return json(response, 401, { error: "unauthorized" });
    if (url.pathname === "/health" && request.method === "GET") {
      return json(response, 200, {
        ok: true,
        processId,
        instanceId,
        appVersion: version,
        buildCommit: sourceCommit,
        debugApiVersion: "1.2.0",
        debugApiPort: candidateAddress().port,
      });
    }
    if (url.pathname === "/browser/state" && request.method === "GET") return json(response, 200, { ok: true });
    if (url.pathname === "/vault/keys" && request.method === "GET") {
      const entries = [...vault.values()].map(redactedEntry);
      return json(response, 200, { keys: entries.map((entry) => entry.key), entries });
    }
    if (url.pathname === "/vault/set" && request.method === "POST") {
      const body = await requestJson(request);
      const key = boundedString(body.key);
      const value = boundedString(body.value);
      if (!key || !value) return json(response, 400, { error: "key and value are required" });
      const prior = vault.get(key);
      vault.set(key, {
        key,
        value,
        description: typeof body.description === "string" ? body.description : prior?.description ?? null,
        userOnly: typeof body.userOnly === "boolean" ? body.userOnly : prior?.userOnly ?? false,
        resourceKind: prior?.resourceKind ?? "secret",
      });
      return json(response, 200, { ok: true, key });
    }
    if (url.pathname === "/vault/delete" && request.method === "POST") {
      const body = await requestJson(request);
      const key = boundedString(body.key);
      if (!key) return json(response, 400, { error: "key is required" });
      vault.delete(key);
      renderedKeys = renderedKeys.filter((candidate) => candidate !== key);
      return json(response, 200, { ok: true, key });
    }
    if (url.pathname === "/state/ui" && request.method === "GET") {
      return json(response, 200, { settingsOpen, settingsTab });
    }
    if (url.pathname === "/state/ui" && request.method === "POST") {
      const body = await requestJson(request);
      if (body.openModal === "settings") settingsOpen = true;
      if (body.openModal === "close") {
        settingsOpen = false;
        resetTransientUi();
      }
      return json(response, 200, { ok: true });
    }
    if (url.pathname === "/audit" && request.method === "GET") {
      return json(response, 200, {
        settingsOpen,
        settingsTab,
        ownedKeyPresent: vault.has(ownedKey),
        redactedDirectory: [...vault.values()].map(redactedEntry),
        renderedOwnedKey: renderedKeys.includes(ownedKey),
        revealedOpen,
        replacing,
        editingMetadata,
        replacementDraftPresent: replacementDraft.length > 0,
        metadataDescriptionDraft,
        metadataUserOnlyDraft,
        newDescriptionDraft,
        newUserOnlyDraft,
        newKeyDraft,
        newValueDraftPresent: newValueDraft.length > 0,
        newValueVisible,
        resourceFormTab,
        generatorOpen,
        generatorRevealed,
        generatorGenerationCount,
        generatorUseCount,
        generatorSaveCount,
        generatorDeleteCount,
        profileLabelDraft,
        walletLabelDraft,
        ownedDeleteArmed,
        ownedDeleteCount,
        ownedResourceSaveCount,
        noticeVisible,
        refreshTransitions,
        revealTransitions,
        replacementSaves,
        metadataSaves,
        secretExposureCount,
        clickedSelectors,
      });
    }
    return json(response, 404, { error: "not found" });
  } catch (error) {
    return json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

const webdriver = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const prefix = `/session/${encodeURIComponent(sessionId)}`;
    if (!url.pathname.startsWith(prefix)) return webdriverError(response, 404, "invalid session id", "unknown session");
    const path = url.pathname.slice(prefix.length) || "/";
    if (request.method === "POST" && path === "/execute/sync") {
      const body = await requestJson(request);
      const script = typeof body.script === "string" ? body.script : "";
      const scriptArgs = Array.isArray(body.args) ? body.args : [];
      if (script.includes("SHELLX_BOUNDED_ELEMENT_OBSERVATION")
        && typeof scriptArgs[0] === "string" && Array.isArray(scriptArgs[1])) {
        const selector = scriptArgs[0];
        const requested = scriptArgs[1].filter((field): field is string => typeof field === "string");
        return webdriverValue(response, boundedObservation(selector, requested));
      }
      return webdriverError(response, 400, "javascript error", "unsupported bounded fixture script");
    }
    if (request.method === "POST" && path === "/element") {
      const body = await requestJson(request);
      const selector = typeof body.value === "string" ? body.value : "";
      if (!selectorDisplayed(selector)) return webdriverError(response, 404, "no such element", `fixture does not expose ${selector}`);
      const id = `vault-element-${nextElementId++}`;
      elementSelectors.set(id, selector);
      return webdriverValue(response, { "element-6066-11e4-a52e-4f735466cecf": id });
    }
    const displayed = path.match(/^\/element\/([^/]+)\/displayed$/);
    if (request.method === "GET" && displayed) {
      const selector = elementSelectors.get(decodeURIComponent(displayed[1]!));
      return webdriverValue(response, Boolean(selector && selectorDisplayed(selector)));
    }
    const clicked = path.match(/^\/element\/([^/]+)\/click$/);
    if (request.method === "POST" && clicked) {
      const selector = elementSelectors.get(decodeURIComponent(clicked[1]!));
      if (!selector || !selectorDisplayed(selector)) return webdriverError(response, 404, "stale element reference", "element is no longer visible");
      click(selector);
      return webdriverValue(response, null);
    }
    const cleared = path.match(/^\/element\/([^/]+)\/clear$/);
    if (request.method === "POST" && cleared) {
      const selector = elementSelectors.get(decodeURIComponent(cleared[1]!));
      if (!selector || !selectorDisplayed(selector)) return webdriverError(response, 404, "stale element reference", "element is no longer visible");
      setInput(selector, "");
      return webdriverValue(response, null);
    }
    const valued = path.match(/^\/element\/([^/]+)\/value$/);
    if (request.method === "POST" && valued) {
      const selector = elementSelectors.get(decodeURIComponent(valued[1]!));
      if (!selector || !selectorDisplayed(selector)) return webdriverError(response, 404, "stale element reference", "element is no longer visible");
      const body = await requestJson(request);
      const text = typeof body.text === "string" ? body.text : "";
      setInput(selector, text);
      return webdriverValue(response, null);
    }
    return webdriverError(response, 404, "unknown command", `unsupported fixture WebDriver route ${path}`);
  } catch (error) {
    return webdriverError(response, 500, "unknown error", error instanceof Error ? error.message : String(error));
  }
});

function selectorDisplayed(selector: string): boolean {
  const vaultOpen = settingsOpen && settingsTab === "vault";
  const ownedRow = vaultOpen && renderedKeys.includes(ownedKey);
  if (selector === settingsDialog) return settingsOpen;
  if (selector === settingsVaultTab) return settingsOpen;
  if (selector === `${settingsVaultTab}[aria-selected='true']`) return vaultOpen;
  if (/^\[data-debug-id='settings-tab-[^']+'\]$/.test(selector)) return settingsOpen;
  if (selector === vaultSecretsTab) return vaultOpen;
  if (selector === profileTab || selector === walletTab) return vaultOpen;
  if (selector === reload) return vaultOpen;
  if (selector === newDescription || selector === newUserOnly || selector === newKey || selector === newValue
    || selector === newGeneratorOpen || selector === newSecretSave) {
    return vaultOpen && resourceFormTab === "secret";
  }
  if (selector === newValueReveal) return vaultOpen && resourceFormTab === "secret";
  if (selector === newValueHide) return vaultOpen && resourceFormTab === "secret" && newValueVisible;
  if (selector === newValueShow) return vaultOpen && resourceFormTab === "secret" && !newValueVisible;
  if (selector === newCopyEnabled) return vaultOpen && resourceFormTab === "secret" && newValueDraft.length > 0;
  if (selector === generator || selector === generatorRegenerate || selector === generatorUse
    || selector === generatorSave || selector === generatorDelete) return vaultOpen && generatorOpen;
  if (selector === generatorReveal) return vaultOpen && generatorOpen && !generatorRevealed;
  if (selector === generatorHide) return vaultOpen && generatorOpen && generatorRevealed;
  if (selector === profileLabel || selector === profileSave) return vaultOpen && resourceFormTab === "profileCard";
  if (selector === walletLabel || selector === walletSave) return vaultOpen && resourceFormTab === "stripeAgentWallet";
  if (selector === ownedDelete) return ownedRow && !ownedDeleteArmed;
  if (selector === ownedConfirmDelete) return ownedRow && ownedDeleteArmed;
  if (selector === dismiss) return vaultOpen && noticeVisible;
  if (selector === reveal) return ownedRow && !revealedOpen && !replacing;
  if (selector === hide) return ownedRow && revealedOpen && !replacing;
  if (selector === revealed || selector === inlineHide || selector === revealMarker) return ownedRow && revealedOpen;
  if (selector === replace) return ownedRow && !replacing;
  if (selector === replaceInput || selector === replaceGenerate || selector === replaceSave || selector === replaceCancel) {
    return ownedRow && replacing;
  }
  if (selector === metadata) return ownedRow && !editingMetadata;
  if (selector === metadataDescription || selector === metadataUserOnly || selector === metadataSave || selector === metadataCancel) {
    return ownedRow && editingMetadata;
  }
  const requestedReplaceKey = selector.match(/^\[aria-label='Replace value for ([^']+)'\]$/)?.[1];
  if (requestedReplaceKey) return vaultOpen && renderedKeys.includes(requestedReplaceKey);
  return false;
}

function click(selector: string): void {
  clickedSelectors.push(selector);
  if (selector === settingsVaultTab) {
    settingsTab = "vault";
    renderedKeys = [...vault.keys()];
  } else if (/^\[data-debug-id='settings-tab-([^']+)'\]$/.test(selector)) {
    settingsTab = selector.match(/^\[data-debug-id='settings-tab-([^']+)'\]$/)?.[1] ?? settingsTab;
  } else if (selector === vaultSecretsTab) {
    // The fixture has one bounded workspace tab.
  } else if (selector === reload) {
    renderedKeys = [...vault.keys()];
    refreshTransitions += 1;
  } else if (selector === reveal) {
    if (!vault.has(ownedKey)) throw new Error("owned Vault row has no backing secret");
    revealedOpen = true;
    noticeVisible = true;
    revealTransitions += 1;
  } else if (selector === hide || selector === inlineHide) {
    revealedOpen = false;
  } else if (selector === dismiss) {
    noticeVisible = false;
  } else if (selector === replace) {
    replacing = true;
    editingMetadata = false;
    replacementDraft = "";
  } else if (selector === replaceGenerate) {
    replacementDraft = "fixture-generated-replacement-material";
  } else if (selector === replaceSave) {
    const entry = vault.get(ownedKey);
    if (!entry || !replacementDraft) throw new Error("replacement Save lacked its exact owned draft");
    entry.value = replacementDraft;
    replacementDraft = "";
    replacing = false;
    replacementSaves += 1;
    noticeVisible = true;
  } else if (selector === replaceCancel) {
    replacementDraft = "";
    replacing = false;
  } else if (selector === metadata) {
    const entry = vault.get(ownedKey);
    if (!entry) throw new Error("owned metadata row is missing");
    editingMetadata = true;
    replacing = false;
    metadataDescriptionDraft = entry.description ?? "";
    metadataUserOnlyDraft = entry.userOnly;
  } else if (selector === metadataUserOnly) {
    metadataUserOnlyDraft = !metadataUserOnlyDraft;
  } else if (selector === metadataSave) {
    const entry = vault.get(ownedKey);
    if (!entry) throw new Error("owned metadata row is missing");
    entry.description = metadataDescriptionDraft || null;
    entry.userOnly = metadataUserOnlyDraft;
    editingMetadata = false;
    metadataSaves += 1;
    noticeVisible = true;
  } else if (selector === metadataCancel) {
    editingMetadata = false;
    metadataDescriptionDraft = "";
    metadataUserOnlyDraft = false;
  } else if (selector === newUserOnly) {
    newUserOnlyDraft = !newUserOnlyDraft;
  } else if (selector === newValueReveal || selector === newValueHide || selector === newValueShow) {
    newValueVisible = !newValueVisible;
  } else if (selector === newGeneratorOpen) {
    generatorOpen = true;
    generatorRevealed = false;
  } else if (selector === generatorReveal || selector === generatorHide) {
    generatorRevealed = !generatorRevealed;
  } else if (selector === generatorRegenerate) {
    generatorRevealed = false;
    generatorGenerationCount += 1;
  } else if (selector === generatorUse) {
    newValueDraft = "fixture-generated-use-material";
    generatorOpen = false;
    generatorRevealed = false;
    generatorUseCount += 1;
  } else if (selector === generatorSave) {
    if (!newKeyDraft) throw new Error("generator Save lacked its exact owned key draft");
    vault.set(newKeyDraft, {
      key: newKeyDraft,
      value: "fixture-generated-save-material",
      description: newDescriptionDraft || null,
      userOnly: newUserOnlyDraft,
      resourceKind: "secret",
    });
    renderedKeys = [...vault.keys()];
    newKeyDraft = "";
    newValueDraft = "";
    newValueVisible = false;
    generatorOpen = false;
    generatorRevealed = false;
    generatorSaveCount += 1;
    ownedResourceSaveCount += 1;
  } else if (selector === generatorDelete) {
    generatorRevealed = false;
    generatorGenerationCount += 1;
    generatorDeleteCount += 1;
  } else if (selector === newSecretSave) {
    if (!newKeyDraft || !newValueDraft) throw new Error("new secret Save lacked its exact owned drafts");
    vault.set(newKeyDraft, {
      key: newKeyDraft,
      value: newValueDraft,
      description: newDescriptionDraft || null,
      userOnly: newUserOnlyDraft,
      resourceKind: "secret",
    });
    renderedKeys = [...vault.keys()];
    newKeyDraft = "";
    newValueDraft = "";
    newValueVisible = false;
    newDescriptionDraft = "";
    newUserOnlyDraft = false;
    ownedResourceSaveCount += 1;
  } else if (selector === profileTab) {
    resourceFormTab = "profileCard";
  } else if (selector === profileSave) {
    if (!profileLabelDraft) throw new Error("profile-card Save lacked its exact owned label draft");
    vault.set(ownedProfileKey, {
      key: ownedProfileKey,
      value: "fixture profile-card payload",
      description: profileLabelDraft,
      userOnly: false,
      resourceKind: "profileCard",
    });
    renderedKeys = [...vault.keys()];
    profileLabelDraft = "";
    ownedResourceSaveCount += 1;
  } else if (selector === walletTab) {
    resourceFormTab = "stripeAgentWallet";
  } else if (selector === walletSave) {
    if (!walletLabelDraft) throw new Error("wallet Save lacked its exact owned label draft");
    vault.set(ownedWalletKey, {
      key: ownedWalletKey,
      value: "fixture wallet payload",
      description: walletLabelDraft,
      userOnly: false,
      resourceKind: "stripeAgentWallet",
    });
    renderedKeys = [...vault.keys()];
    walletLabelDraft = "";
    ownedResourceSaveCount += 1;
  } else if (selector === ownedDelete) {
    ownedDeleteArmed = true;
  } else if (selector === ownedConfirmDelete) {
    if (!vault.has(ownedKey)) throw new Error("owned delete confirmation lost its disposable target");
    vault.delete(ownedKey);
    renderedKeys = renderedKeys.filter((key) => key !== ownedKey);
    ownedDeleteArmed = false;
    ownedDeleteCount += 1;
  } else {
    throw new Error(`fixture click is not implemented for ${selector}`);
  }
}

function setInput(selector: string, text: string): void {
  if (selector === replaceInput) replacementDraft = text;
  else if (selector === metadataDescription) metadataDescriptionDraft = text;
  else if (selector === newDescription) newDescriptionDraft = text;
  else if (selector === newKey) newKeyDraft = text;
  else if (selector === newValue) newValueDraft = text;
  else if (selector === profileLabel) profileLabelDraft = text;
  else if (selector === walletLabel) walletLabelDraft = text;
  else throw new Error(`fixture text entry is not implemented for ${selector}`);
}

function boundedObservation(selector: string, requested: string[]): Record<string, unknown> {
  const observation: Record<string, unknown> = {};
  for (const field of requested) {
    if (field === "value") {
      if (selector === metadataDescription) observation.value = metadataDescriptionDraft;
      else if (selector === newDescription) observation.value = newDescriptionDraft;
      else {
        secretExposureCount += 1;
        throw new Error("fixture refuses a secret-bearing value observation");
      }
    } else if (field === "checked") {
      if (selector === metadataUserOnly) observation.checked = metadataUserOnlyDraft;
      else if (selector === newUserOnly) observation.checked = newUserOnlyDraft;
      else throw new Error(`fixture has no checked observation for ${selector}`);
    } else if (field === "disabled") {
      if (selector === replaceSave) observation.disabled = replacementDraft.length === 0;
      else if (selector === metadataSave) observation.disabled = false;
      else throw new Error(`fixture has no disabled observation for ${selector}`);
    } else {
      throw new Error(`fixture does not support observation field ${field}`);
    }
  }
  return {
    present: selectorDisplayed(selector),
    visible: selectorDisplayed(selector),
    observation,
  };
}

function resetTransientUi(): void {
  revealedOpen = false;
  replacing = false;
  replacementDraft = "";
  editingMetadata = false;
  metadataDescriptionDraft = "";
  metadataUserOnlyDraft = false;
  newDescriptionDraft = "";
  newUserOnlyDraft = false;
  newKeyDraft = "";
  newValueDraft = "";
  newValueVisible = false;
  resourceFormTab = "secret";
  generatorOpen = false;
  generatorRevealed = false;
  profileLabelDraft = "";
  walletLabelDraft = "";
  ownedDeleteArmed = false;
  noticeVisible = false;
  renderedKeys = [];
}

function redactedEntry(entry: VaultStoredEntry): VaultEntry {
  return {
    key: entry.key,
    description: entry.description,
    userOnly: entry.userOnly,
    ...(entry.resourceKind ? { resourceKind: entry.resourceKind } : {}),
  };
}

function authorized(request: IncomingMessage): boolean {
  return request.headers.authorization === `Bearer ${token}`;
}

async function requestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBody(request);
  if (!text) return {};
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request body must be an object");
  return value as Record<string, unknown>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function boundedString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 64 * 1024 ? value : null;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function webdriverValue(response: ServerResponse, value: unknown): void {
  json(response, 200, { value });
}

function webdriverError(response: ServerResponse, status: number, error: string, message: string): void {
  json(response, status, { value: { error, message, stacktrace: "" } });
}

function requiredArg(values: string[], name: string): string {
  const index = values.indexOf(name);
  const value = index >= 0
    ? values[index + 1]
    : values.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}

function candidateAddress(): { port: number } {
  const address = candidate.address();
  if (!address || typeof address === "string") throw new Error("candidate fixture is not listening");
  return address;
}

candidate.listen(0, "127.0.0.1", () => {
  webdriver.listen(0, "127.0.0.1", () => {
    const webdriverAddress = webdriver.address();
    if (!webdriverAddress || typeof webdriverAddress === "string") throw new Error("WebDriver fixture is not listening");
    writeFileSync(statePath, `${JSON.stringify({
      candidatePort: candidateAddress().port,
      webdriverPort: webdriverAddress.port,
    })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => candidate.close(() => webdriver.close(() => process.exit(0))));
}
