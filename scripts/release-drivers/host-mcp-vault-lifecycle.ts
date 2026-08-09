export const HOST_MCP_VAULT_LIFECYCLE_TOOLS = new Set([
  "browser_capture_secret_to_vault",
  "browser_read_email_code",
  "browser_use_agent_wallet",
]);

export const HOST_MCP_VAULT_FIXTURE_ID = "host-mcp:installed-vault-e2e-browser-lifecycle";
export const HOST_MCP_VAULT_CLEANUP_ID = "host-mcp:reset-isolated-vault-close-owned-browser-task-and-restore-autonomy";

export const HOST_MCP_CAPTURE_FIXTURE_VALUE = "shellx-owned-capture-value-035";
export const HOST_MCP_EMAIL_CODE_FIXTURE = "735204";
export const HOST_MCP_WALLET_FIXTURE_MARKER = "acct_shellx_owned_035";

type JsonObject = Record<string, unknown>;

export type HostMcpDebugJson = (
  path: string,
  body?: JsonObject,
  additionalHeaders?: Record<string, string>,
  timeoutMs?: number,
) => Promise<JsonObject>;

export type HostMcpExpectedToolError = (
  name: string,
  args: JsonObject,
  expectedSubstring: string,
  mutation?: boolean,
) => Promise<void>;

export interface HostMcpVaultLifecycleState {
  namespace: string;
  captureSecretRef: string;
  emailResourceRef: string;
  walletResourceRef: string;
  emailGrantId: string | null;
  walletGrantId: string | null;
  cleanupRequired: boolean;
}

export function createHostMcpVaultLifecycle(instanceId: string): HostMcpVaultLifecycleState {
  const namespace = `shellx-release-${instanceId}-vault`;
  return {
    namespace,
    captureSecretRef: `${namespace}-captured`,
    emailResourceRef: `${namespace}-email`,
    walletResourceRef: `${namespace}-wallet`,
    emailGrantId: null,
    walletGrantId: null,
    cleanupRequired: false,
  };
}

export async function prepareHostMcpVaultLifecycle(
  state: HostMcpVaultLifecycleState,
  debugJson: HostMcpDebugJson,
  browserOrigin: string,
): Promise<void> {
  state.cleanupRequired = true;
  verifyReset(await debugJson("/vault/e2e/reset", {}), "initial reset");

  await seedResource(debugJson, state.emailResourceRef, JSON.stringify({
    latestCode: HOST_MCP_EMAIL_CODE_FIXTURE,
    mailbox: "owned-release-fixture",
  }), {
    resourceKind: "emailInbox",
    resourceSummary: "Owned release email inbox",
    resourceProvider: "fixture",
    resourceFields: ["latestCode"],
  });
  await seedResource(debugJson, state.walletResourceRef, JSON.stringify({
    accountId: HOST_MCP_WALLET_FIXTURE_MARKER,
    mode: "test",
  }), {
    resourceKind: "stripeAgentWallet",
    resourceSummary: "Owned unavailable wallet fixture",
    resourceProvider: "stripe-test",
    resourceFields: ["accountId", "mode"],
  });

  state.emailGrantId = await approveGrant(
    debugJson,
    state.emailResourceRef,
    "emailCodeRead",
    HOST_MCP_EMAIL_CODE_FIXTURE,
    browserOrigin,
  );
  state.walletGrantId = await approveGrant(
    debugJson,
    state.walletResourceRef,
    "agentWalletUse",
    HOST_MCP_WALLET_FIXTURE_MARKER,
    browserOrigin,
  );

  await verifyGrantProbe(debugJson, state.emailResourceRef, state.emailGrantId, "emailCodeRead", browserOrigin);
  await verifyGrantProbe(debugJson, state.walletResourceRef, state.walletGrantId, "agentWalletUse", browserOrigin);
}

export function hostMcpVaultArguments(
  name: string,
  state: HostMcpVaultLifecycleState,
  browserTaskId: string | null,
): JsonObject {
  if (!browserTaskId) throw new Error(`${name} requires the exact owned Browser task`);
  if (name === "browser_capture_secret_to_vault") {
    return {
      taskId: browserTaskId,
      selector: "#capturable-secret",
      secretRef: state.captureSecretRef,
    };
  }
  if (name === "browser_read_email_code") {
    return {
      taskId: browserTaskId,
      grantId: requiredStateString(state.emailGrantId, "email grant"),
      resourceRef: state.emailResourceRef,
    };
  }
  if (name === "browser_use_agent_wallet") {
    return {
      taskId: browserTaskId,
      grantId: requiredStateString(state.walletGrantId, "wallet grant"),
      resourceRef: state.walletResourceRef,
    };
  }
  throw new Error(`unsupported Host MCP Vault lifecycle tool ${name}`);
}

export async function verifyHostMcpVaultResult(
  name: string,
  result: JsonObject,
  state: HostMcpVaultLifecycleState,
  browserTaskId: string,
  debugJson: HostMcpDebugJson,
): Promise<string> {
  if (name === "browser_capture_secret_to_vault") {
    const vaultRef = requiredString(result.vaultRef, "capture vaultRef");
    if (result.secretExposed !== false || result.taskId !== browserTaskId
      || result.label !== state.captureSecretRef
      || !vaultRef.startsWith(`browser-deposits/${state.namespace}-browser-deposit-`)
      || !requiredString(result.depositId, "capture depositId").startsWith("browser-deposit-")
      || !/^[a-f0-9]{64}$/.test(requiredString(result.storageCommitHash, "capture storageCommitHash"))) {
      throw new Error("browser_capture_secret_to_vault omitted its exact redacted write receipt");
    }
    const receipt = requireRecord(result.receipt, "capture receipt");
    verifyBrowserReceipt(receipt, {
      kind: "browserVaultDepositCreated",
      taskId: browserTaskId,
      itemId: vaultRef,
      action: null,
    });
    const probe = await debugJson("/vault/e2e/probe-use", {
      secretRef: vaultRef,
      operation: "deposit",
      actor: { agentId: "shellx-release-proof" },
    });
    if (probe.secretPresent !== true || probe.secretExposed !== false
      || probe.secretRef !== vaultRef) {
      throw new Error("browser_capture_secret_to_vault did not persist the exact owned item without exposing it");
    }
    return "Host MCP permission-gated one owned loopback page-secret capture, proved the exact isolated Vault item present through a redacted probe, and retained no secret value in evidence.";
  }

  if (name === "browser_read_email_code") {
    const grantId = requiredStateString(state.emailGrantId, "email grant");
    if (result.ok !== true || result.status !== "applied" || result.action !== "readEmailCodeGrant"
      || result.resourceRef !== state.emailResourceRef || result.grantId !== grantId
      || result.code !== HOST_MCP_EMAIL_CODE_FIXTURE || result.codeReturned !== true
      || result.secretExposed !== true || !requiredString(result.receiptId, "email receiptId")) {
      throw new Error("browser_read_email_code omitted its exact approved synthetic-code result");
    }
    await verifyReceiptInBrowserState(debugJson, {
      kind: "browserEmailCodeRead",
      taskId: browserTaskId,
      itemId: state.emailResourceRef,
      action: "emailCodeRead",
      grantId,
    });
    return "Host MCP permission-gated one approved synthetic email-code read from the isolated Vault resource and proved its metadata-only receipt without retaining the code in release evidence.";
  }

  throw new Error(`unsupported successful Host MCP Vault result ${name}`);
}

export async function exerciseHostMcpWalletUnavailable(
  state: HostMcpVaultLifecycleState,
  browserTaskId: string,
  callToolExpectingError: HostMcpExpectedToolError,
  debugJson: HostMcpDebugJson,
): Promise<string> {
  await callToolExpectingError(
    "browser_use_agent_wallet",
    hostMcpVaultArguments("browser_use_agent_wallet", state, browserTaskId),
    "browser_agent_wallet_checkout_unavailable",
    true,
  );
  await verifyReceiptInBrowserState(debugJson, {
    kind: "browserAgentWalletCheckoutUnavailable",
    taskId: browserTaskId,
    itemId: state.walletResourceRef,
    action: "agentWalletUnavailable",
    grantId: requiredStateString(state.walletGrantId, "wallet grant"),
  });
  return "Host MCP permission-gated and validated the isolated agent-wallet grant, then proved the declared typed checkout-unavailable error and metadata-only receipt; no payment success or provider transaction was claimed.";
}

export async function cleanupHostMcpVaultLifecycle(
  state: HostMcpVaultLifecycleState,
  debugJson: HostMcpDebugJson,
): Promise<string | null> {
  if (!state.cleanupRequired) return null;
  try {
    verifyReset(await debugJson("/vault/e2e/reset", {}), "cleanup reset");
    const resources = await debugJson(`/vault/resources?prefix=${encodeURIComponent(state.namespace)}`);
    const rows = requireArray(resources.resources, "cleanup resources");
    if (resources.secretExposed !== false || rows.length !== 0) {
      throw new Error("isolated Vault resources remained after cleanup reset");
    }
    const audit = await debugJson("/vault/e2e/audit");
    const records = requireArray(audit.audit, "cleanup audit").map((row) => requireRecord(row, "cleanup audit row"));
    if (audit.secretExposed !== false || records.length !== 1
      || records[0]?.action !== "vaultE2eReset" || records[0]?.secretExposed !== false) {
      throw new Error("isolated Vault cleanup did not end at one exact redacted reset receipt");
    }
    state.cleanupRequired = false;
    return null;
  } catch (error) {
    return `Host MCP Vault lifecycle cleanup: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function seedResource(
  debugJson: HostMcpDebugJson,
  key: string,
  value: string,
  metadata: JsonObject,
): Promise<void> {
  const response = await debugJson("/vault/set", {
    key,
    value,
    description: "Disposable Host MCP release fixture",
    userOnly: false,
    ...metadata,
  });
  if (response.ok !== true || response.key !== key || JSON.stringify(response).includes(value)) {
    throw new Error("isolated Vault resource seed did not return its exact redacted acknowledgement");
  }
}

async function approveGrant(
  debugJson: HostMcpDebugJson,
  resourceRef: string,
  operation: string,
  forbiddenValue: string,
  browserOrigin: string,
): Promise<string> {
  const response = await debugJson("/vault/e2e/approve-grant", {
    secretRef: resourceRef,
    actorScope: { kind: "allShellxAgents" },
    operation,
    origin: browserOrigin,
    expiresAtMs: Date.now() + 10 * 60 * 1_000,
  });
  const grant = requireRecord(response.grant, `${operation} grant`);
  const grantId = requiredString(grant.grantId, `${operation} grantId`);
  const expectedOperation = operation === "emailCodeRead" ? "EmailCodeRead" : "AgentWalletUse";
  if (response.ok !== true || response.secretExposed !== false || grant.approved !== true
    || grant.secretRef !== resourceRef || grant.operation !== expectedOperation
    || grant.origin !== browserOrigin
    || JSON.stringify(response).includes(forbiddenValue)) {
    throw new Error(`isolated Vault ${operation} grant was not approved with a redacted receipt`);
  }
  return grantId;
}

async function verifyGrantProbe(
  debugJson: HostMcpDebugJson,
  resourceRef: string,
  grantId: string,
  operation: string,
  browserOrigin: string,
): Promise<void> {
  const response = await debugJson("/vault/e2e/probe-use", {
    grantId,
    secretRef: resourceRef,
    operation,
    actor: { agentId: "shellx-release-proof", origin: browserOrigin },
  });
  if (response.ok !== true || response.decision !== "allowMediated"
    || response.secretPresent !== true || response.secretExposed !== false
    || response.secretRef !== resourceRef || response.grantId !== grantId) {
    throw new Error(`isolated Vault ${operation} grant did not authorize the owned resource`);
  }
}

async function verifyReceiptInBrowserState(
  debugJson: HostMcpDebugJson,
  expected: { kind: string; taskId: string; itemId: string; action: string; grantId: string },
): Promise<void> {
  const state = await debugJson("/browser/state");
  const receipts = requireArray(state.receipts, "Browser receipts").map((row) => requireRecord(row, "Browser receipt"));
  const receipt = receipts.find((row) => row.kind === expected.kind && row.taskId === expected.taskId);
  if (!receipt) throw new Error(`${expected.kind} receipt was absent from the installed Browser state`);
  verifyBrowserReceipt(receipt, expected);
}

function verifyBrowserReceipt(
  receipt: JsonObject,
  expected: { kind: string; taskId: string; itemId: string; action: string | null; grantId?: string },
): void {
  const evidence = requireRecord(receipt.evidence, `${expected.kind} evidence`);
  const itemMatches = expected.kind === "browserVaultDepositCreated"
    ? evidence.vaultRef === expected.itemId && evidence.vaultWriteCommitted === true
    : evidence.itemId === expected.itemId;
  if (receipt.kind !== expected.kind || receipt.taskId !== expected.taskId
    || !requiredString(receipt.receiptId, `${expected.kind} receiptId`)
    || evidence.secretExposed !== false || !itemMatches
    || (expected.action !== null && evidence.action !== expected.action)
    || (expected.grantId !== undefined && evidence.grantId !== expected.grantId)) {
    throw new Error(`${expected.kind} receipt did not match its exact redacted lifecycle effect`);
  }
}

function verifyReset(response: JsonObject, label: string): void {
  const receipt = requireRecord(response.receipt, `${label} receipt`);
  if (response.ok !== true || receipt.action !== "vaultE2eReset" || receipt.secretExposed !== false) {
    throw new Error(`${label} did not prove the isolated Vault E2E reset`);
  }
}

function requiredStateString(value: string | null, label: string): string {
  if (!value) throw new Error(`${label} was not prepared`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requireRecord(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}
