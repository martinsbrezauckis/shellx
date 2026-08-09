import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";

const VAULT_E2E_MUTATION_PATHS = new Set([
  "/vault/e2e/reset",
  "/vault/e2e/seed-secret",
  "/vault/e2e/approve-grant",
  "/vault/e2e/deny-grant",
  "/vault/e2e/revoke-grant",
  "/vault/e2e/expire-grant",
  "/vault/e2e/probe-use",
]);
const VAULT_OWNED_GRANT_MUTATIONS = new Set([
  "POST /vault/grants",
  "POST /vault/grants/:grant_id/revoke",
]);
const VAULT_BROWSER_ORIGIN = "https://example.com";

type DebugApiConnection = { base: string; token: string };
type DriverAssignment = ReleaseSurfaceDriverRequest["assignments"][number];

export function isDebugApiVaultE2eMutation(name: string): boolean {
  return name.startsWith("POST ") && VAULT_E2E_MUTATION_PATHS.has(name.slice("POST ".length));
}

export function isDebugApiVaultOwnedGrantMutation(name: string): boolean {
  return VAULT_OWNED_GRANT_MUTATIONS.has(name);
}

export async function exerciseDebugApiVaultOwnedGrantMutation(
  connection: DebugApiConnection,
  request: ReleaseSurfaceDriverRequest,
  assignment: DriverAssignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const revoke = assignment.surface.name === "POST /vault/grants/:grant_id/revoke";
  const segment = request.sourceCommit.slice(0, 16);
  const secretRef = `release-surface/e2e/normal-grant-${revoke ? "revoke" : "create"}/${segment}`;
  const secretValue = `SHELLX_RELEASE_VAULT_E2E_SECRET_${request.sourceCommit}`;
  const outcome: ReleaseSurfaceDriverOutcome = {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No isolated Vault grant lifecycle effect was observed.",
  };
  try {
    if (!VAULT_OWNED_GRANT_MUTATIONS.has(assignment.surface.name)) {
      throw new Error(`unsupported owned Vault grant route ${assignment.surface.name}`);
    }
    await resetVaultE2e(connection);
    await seedVaultE2eSecret(connection, secretRef, secretValue);
    let grant = validatePendingGrantResponse(
      await postVaultE2e(connection, "/vault/grants", grantRequest(secretRef), secretValue),
      secretRef,
    );
    outcome.present = "pass";
    if (revoke) {
      const body = await postVaultE2e(
        connection,
        `/vault/grants/${encodeURIComponent(grant.grantId)}/revoke`,
        {},
        secretValue,
      );
      requireExactKeys(body, ["grantId", "ok"], "POST /vault/grants/:grant_id/revoke");
      if (body.ok !== true || body.grantId !== grant.grantId) {
        throw new Error("Vault grant revoke returned the wrong owned grant identity");
      }
    }
    outcome.invoke = "pass";
    const grants = await readVaultGrants(connection, secretValue);
    const matching = grants.filter((candidate) => candidate.grantId === grant.grantId);
    if (matching.length !== 1) throw new Error("Vault grant directory omitted its exact owned grant");
    grant = matching[0]!;
    if (grant.secretRef !== secretRef || grant.approved !== false || grant.revoked !== revoke) {
      throw new Error(`Vault grant directory did not preserve the exact owned ${revoke ? "revoked" : "pending"} state`);
    }
    outcome.effect = "pass";
    outcome.observedEffect = `${assignment.surface.name} completed its exact owned ${revoke ? "revoked" : "pending"} grant transition inside the disposable Vault profile; secret and grant identities were not retained.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await resetVaultE2e(connection);
      const cleanupAudit = await readVaultE2eAudit(connection, secretValue);
      if (cleanupAudit.length !== 1 || cleanupAudit[0]?.action !== "vaultE2eReset"
        || cleanupAudit[0].secretExposed !== false || cleanupAudit[0].secretRef !== null
        || cleanupAudit[0].grantId !== null || cleanupAudit[0].decision !== null
        || cleanupAudit[0].secretPresent !== null || cleanupAudit[0].reason !== null) {
        throw new Error("isolated Vault grant state did not return to its exact reset baseline");
      }
      outcome.cleanup = "pass";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return outcome;
}

export async function exerciseDebugApiVaultE2eMutation(
  connection: DebugApiConnection,
  request: ReleaseSurfaceDriverRequest,
  assignment: DriverAssignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const path = assignment.surface.name.slice("POST ".length);
  const segment = request.sourceCommit.slice(0, 16);
  const secretRef = `release-surface/e2e/${path.split("/").at(-1)}/${segment}`;
  const secretValue = `SHELLX_RELEASE_VAULT_E2E_SECRET_${request.sourceCommit}`;
  const outcome: ReleaseSurfaceDriverOutcome = {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No isolated Vault E2E lifecycle effect was observed.",
  };
  try {
    if (!VAULT_E2E_MUTATION_PATHS.has(path)) throw new Error(`unsupported Vault E2E route ${path}`);
    await resetVaultE2e(connection);

    let grantId: string | null = null;
    if (path === "/vault/e2e/reset") {
      await seedVaultE2eSecret(connection, secretRef, secretValue);
    } else if (path !== "/vault/e2e/seed-secret") {
      await seedVaultE2eSecret(connection, secretRef, secretValue);
      if ([
        "/vault/e2e/revoke-grant",
        "/vault/e2e/expire-grant",
        "/vault/e2e/probe-use",
      ].includes(path)) {
        grantId = await approveVaultE2eGrant(connection, secretRef, secretValue);
      }
    }

    outcome.present = "pass";
    const expectedAction = expectedVaultE2eAction(path);
    if (path === "/vault/e2e/reset") {
      validateDebugApiVaultResetResponse(await postVaultE2e(connection, path, {}, secretValue));
    } else if (path === "/vault/e2e/seed-secret") {
      validateSeedResponse(
        await postVaultE2e(connection, path, { secretRef, value: secretValue }, secretValue),
        secretRef,
      );
    } else if (path === "/vault/e2e/approve-grant") {
      grantId = validateApproveResponse(
        await postVaultE2e(connection, path, grantRequest(secretRef), secretValue),
        secretRef,
      );
    } else if (path === "/vault/e2e/deny-grant") {
      validateDecisionResponse(
        await postVaultE2e(connection, path, {
          secretRef,
          reason: "releaseSurfaceDenied",
        }, secretValue),
        "vaultE2eGrantDenied",
        secretRef,
        null,
      );
    } else if (path === "/vault/e2e/revoke-grant" || path === "/vault/e2e/expire-grant") {
      if (!grantId) throw new Error(`${path} prerequisite grant was unavailable`);
      validateDecisionResponse(
        await postVaultE2e(connection, path, { grantId }, secretValue),
        expectedAction,
        secretRef,
        grantId,
      );
    } else {
      if (!grantId) throw new Error("Vault E2E probe prerequisite grant was unavailable");
      validateProbeResponse(
        await postVaultE2e(connection, path, {
          grantId,
          secretRef,
          operation: "fill",
          actor: { agentId: "shellx-release-driver", origin: VAULT_BROWSER_ORIGIN },
        }, secretValue),
        secretRef,
        grantId,
      );
    }
    outcome.invoke = "pass";

    const audit = await readVaultE2eAudit(connection, secretValue);
    const last = audit.at(-1);
    const actionUsesSecretRef = [
      "/vault/e2e/seed-secret",
      "/vault/e2e/approve-grant",
      "/vault/e2e/deny-grant",
      "/vault/e2e/probe-use",
    ].includes(path);
    const actionUsesGrantId = [
      "/vault/e2e/approve-grant",
      "/vault/e2e/revoke-grant",
      "/vault/e2e/expire-grant",
      "/vault/e2e/probe-use",
    ].includes(path);
    if (!last || last.action !== expectedAction || last.secretExposed !== false
      || last.secretRef !== (actionUsesSecretRef ? secretRef : null)
      || last.grantId !== (actionUsesGrantId ? grantId : null)
      || last.decision !== (path === "/vault/e2e/probe-use" ? "allowMediated" : null)
      || last.secretPresent !== (["/vault/e2e/seed-secret", "/vault/e2e/probe-use"].includes(path) ? true : null)) {
      throw new Error(`${path} did not append its exact redacted Vault E2E audit action`);
    }
    if (path === "/vault/e2e/reset"
      && (audit.length !== 1 || last.action !== "vaultE2eReset" || last.reason !== null)) {
      throw new Error("Vault E2E reset did not clear the prior isolated audit state");
    }
    outcome.effect = "pass";
    outcome.observedEffect = `${assignment.surface.name} completed its exact isolated, redacted Vault lifecycle transition; secret, grant, and receipt identities were not retained.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await resetVaultE2e(connection);
      const cleanupAudit = await readVaultE2eAudit(connection, secretValue);
      if (cleanupAudit.length !== 1 || cleanupAudit[0]?.action !== "vaultE2eReset"
        || cleanupAudit[0].secretExposed !== false || cleanupAudit[0].secretRef !== null
        || cleanupAudit[0].grantId !== null || cleanupAudit[0].decision !== null
        || cleanupAudit[0].secretPresent !== null || cleanupAudit[0].reason !== null) {
        throw new Error("isolated Vault E2E state did not return to its exact reset baseline");
      }
      outcome.cleanup = "pass";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return outcome;
}

function grantRequest(secretRef: string): Record<string, unknown> {
  return {
    secretRef,
    actorScope: { kind: "allShellxAgents" },
    operation: "fill",
    origin: VAULT_BROWSER_ORIGIN,
    expiresAtMs: Date.now() + 10 * 60 * 1_000,
  };
}

async function approveVaultE2eGrant(
  connection: DebugApiConnection,
  secretRef: string,
  secretValue: string,
): Promise<string> {
  return validateApproveResponse(
    await postVaultE2e(connection, "/vault/e2e/approve-grant", grantRequest(secretRef), secretValue),
    secretRef,
  );
}

async function seedVaultE2eSecret(
  connection: DebugApiConnection,
  secretRef: string,
  secretValue: string,
): Promise<void> {
  validateSeedResponse(
    await postVaultE2e(connection, "/vault/e2e/seed-secret", { secretRef, value: secretValue }, secretValue),
    secretRef,
  );
}

async function resetVaultE2e(connection: DebugApiConnection): Promise<void> {
  validateDebugApiVaultResetResponse(await postVaultE2e(connection, "/vault/e2e/reset", {}, ""));
}

async function postVaultE2e(
  connection: DebugApiConnection,
  path: string,
  requestBody: Record<string, unknown>,
  secretValue: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${connection.base}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });
  const text = await response.text();
  if (response.status !== 200) throw new Error(`POST ${path} returned ${response.status}`);
  if (secretValue && text.includes(secretValue)) throw new Error(`POST ${path} echoed the isolated secret value`);
  return requireObject(JSON.parse(text) as unknown, `POST ${path}`);
}

async function readVaultE2eAudit(
  connection: DebugApiConnection,
  secretValue: string,
): Promise<VaultE2eAuditRecord[]> {
  const response = await fetch(`${connection.base}/vault/e2e/audit`, {
    headers: { Authorization: `Bearer ${connection.token}` },
  });
  const text = await response.text();
  if (response.status !== 200) throw new Error(`GET /vault/e2e/audit returned ${response.status}`);
  if (secretValue && text.includes(secretValue)) throw new Error("Vault E2E audit exposed the isolated secret value");
  const body = requireObject(JSON.parse(text) as unknown, "GET /vault/e2e/audit");
  requireExactKeys(body, ["audit", "ok", "secretExposed"], "GET /vault/e2e/audit");
  if (body.ok !== true || body.secretExposed !== false || !Array.isArray(body.audit)) {
    throw new Error("Vault E2E audit omitted its explicit redacted array contract");
  }
  return body.audit.map((entry, index) => validateAuditRecord(entry, `Vault E2E audit[${index}]`));
}

type VaultGrantRecord = {
  grantId: string;
  secretRef: string;
  actorScope: string;
  operation: string;
  origin: string | null;
  createdAtMs: number;
  expiresAtMs: number | null;
  revoked: boolean;
  approved: boolean;
};

async function readVaultGrants(
  connection: DebugApiConnection,
  secretValue: string,
): Promise<VaultGrantRecord[]> {
  const response = await fetch(`${connection.base}/vault/grants`, {
    headers: { Authorization: `Bearer ${connection.token}` },
  });
  const text = await response.text();
  if (response.status !== 200) throw new Error(`GET /vault/grants returned ${response.status}`);
  if (secretValue && text.includes(secretValue)) throw new Error("Vault grant directory exposed the isolated secret value");
  const body = requireObject(JSON.parse(text) as unknown, "GET /vault/grants");
  requireExactKeys(body, ["grants"], "GET /vault/grants");
  if (!Array.isArray(body.grants)) throw new Error("GET /vault/grants omitted its grant array");
  return body.grants.map((entry, index) => validateGrant(entry, `GET /vault/grants[${index}]`));
}

function validatePendingGrantResponse(
  body: Record<string, unknown>,
  secretRef: string,
): VaultGrantRecord {
  requireExactKeys(body, ["grant", "ok"], "POST /vault/grants");
  if (body.ok !== true) throw new Error("POST /vault/grants did not confirm success");
  const grant = validateGrant(body.grant, "POST /vault/grants.grant");
  if (grant.secretRef !== secretRef || grant.revoked !== false || grant.approved !== false) {
    throw new Error("POST /vault/grants returned the wrong owned pending grant state");
  }
  return grant;
}

function validateGrant(value: unknown, label: string): VaultGrantRecord {
  const grant = requireObject(value, label);
  requireExactKeys(grant, [
    "actorScope", "approved", "createdAtMs", "expiresAtMs", "grantId", "operation", "origin",
    "revoked", "secretRef",
  ], label);
  if (typeof grant.grantId !== "string" || !grant.grantId
    || typeof grant.secretRef !== "string" || !grant.secretRef
    || typeof grant.actorScope !== "string" || !grant.actorScope
    || grant.operation !== "Fill" || grant.origin !== VAULT_BROWSER_ORIGIN
    || !Number.isSafeInteger(grant.createdAtMs)
    || (grant.expiresAtMs !== null && !Number.isSafeInteger(grant.expiresAtMs))
    || typeof grant.revoked !== "boolean" || typeof grant.approved !== "boolean") {
    throw new Error(`${label} returned invalid redacted grant metadata`);
  }
  return grant as VaultGrantRecord;
}

type VaultE2eAuditRecord = {
  action: string;
  decision: string | null;
  grantId: string | null;
  reason: string | null;
  receiptId: string;
  secretExposed: false;
  secretPresent: boolean | null;
  secretRef: string | null;
};

function validateAuditRecord(value: unknown, label: string): VaultE2eAuditRecord {
  const record = requireObject(value, label);
  requireExactKeys(record, [
    "action", "decision", "grantId", "reason", "receiptId", "secretExposed",
    "secretPresent", "secretRef", "t",
  ], label);
  if (typeof record.action !== "string" || !record.action
    || typeof record.receiptId !== "string" || !record.receiptId.startsWith("vault-e2e-")
    || record.secretExposed !== false || !Number.isSafeInteger(record.t)
    || (record.secretRef !== null && typeof record.secretRef !== "string")
    || (record.grantId !== null && typeof record.grantId !== "string")
    || (record.decision !== null && typeof record.decision !== "string")
    || (record.reason !== null && typeof record.reason !== "string")
    || (record.secretPresent !== null && typeof record.secretPresent !== "boolean")) {
    throw new Error(`${label} returned invalid redacted receipt metadata`);
  }
  return record as VaultE2eAuditRecord;
}

export function validateDebugApiVaultResetResponse(body: Record<string, unknown>): void {
  requireExactKeys(body, ["ok", "receipt"], "POST /vault/e2e/reset");
  const receipt = validateAuditRecord(body.receipt, "Vault E2E reset receipt");
  if (body.ok !== true || receipt.action !== "vaultE2eReset" || receipt.secretRef !== null
    || receipt.grantId !== null || receipt.decision !== null || receipt.secretPresent !== null
    || receipt.reason !== null) {
    throw new Error("Vault E2E reset returned the wrong receipt");
  }
}

function validateSeedResponse(body: Record<string, unknown>, secretRef: string): void {
  requireExactKeys(body, ["ok", "receipt", "secretExposed", "secretPresent", "secretRef"], "POST /vault/e2e/seed-secret");
  const receipt = validateAuditRecord(body.receipt, "Vault E2E seed receipt");
  if (body.ok !== true || body.secretRef !== secretRef || body.secretPresent !== true || body.secretExposed !== false
    || receipt.action !== "vaultE2eSecretSeeded" || receipt.secretRef !== secretRef
    || receipt.secretPresent !== true || receipt.grantId !== null || receipt.decision !== null) {
    throw new Error("Vault E2E seed returned the wrong redacted secret-presence contract");
  }
}

function validateApproveResponse(body: Record<string, unknown>, secretRef: string): string {
  requireExactKeys(body, ["grant", "ok", "receipt", "secretExposed"], "POST /vault/e2e/approve-grant");
  const grant = requireObject(body.grant, "Vault E2E approved grant");
  requireExactKeys(grant, [
    "actorScope", "approved", "createdAtMs", "expiresAtMs", "grantId", "operation", "origin",
    "revoked", "secretRef",
  ], "Vault E2E approved grant");
  const receipt = validateAuditRecord(body.receipt, "Vault E2E approval receipt");
  if (body.ok !== true || body.secretExposed !== false || grant.secretRef !== secretRef
    || grant.approved !== true || grant.revoked !== false || typeof grant.grantId !== "string" || !grant.grantId
    || typeof grant.actorScope !== "string" || !grant.actorScope || grant.operation !== "Fill"
    || grant.origin !== VAULT_BROWSER_ORIGIN
    || !Number.isSafeInteger(grant.createdAtMs) || !Number.isSafeInteger(grant.expiresAtMs)
    || receipt.action !== "vaultE2eGrantApproved" || receipt.secretRef !== secretRef
    || receipt.grantId !== grant.grantId || receipt.decision !== null || receipt.secretPresent !== null) {
    throw new Error("Vault E2E approval returned the wrong mediated grant contract");
  }
  return grant.grantId;
}

function validateDecisionResponse(
  body: Record<string, unknown>,
  action: string,
  secretRef: string,
  grantId: string | null,
): void {
  const denial = action === "vaultE2eGrantDenied";
  requireExactKeys(
    body,
    denial ? ["grantId", "ok", "reason", "receipt", "secretExposed"] : ["grantId", "ok", "receipt", "secretExposed"],
    `Vault E2E ${action}`,
  );
  const receipt = validateAuditRecord(body.receipt, `Vault E2E ${action} receipt`);
  if (body.ok !== true || body.secretExposed !== false || body.grantId !== grantId
    || receipt.action !== action || receipt.secretRef !== (denial ? secretRef : null)
    || receipt.grantId !== grantId || (denial && body.reason !== "releaseSurfaceDenied")) {
    throw new Error(`Vault E2E ${action} returned the wrong redacted lifecycle contract`);
  }
}

function validateProbeResponse(body: Record<string, unknown>, secretRef: string, grantId: string): void {
  requireExactKeys(body, [
    "actor", "decision", "grantId", "ok", "operation", "reason", "receiptId",
    "secretExposed", "secretPresent", "secretRef",
  ], "POST /vault/e2e/probe-use");
  const actor = requireObject(body.actor, "Vault E2E probe actor");
  if (body.ok !== true || body.decision !== "allowMediated" || body.reason !== null
    || body.secretRef !== secretRef || body.grantId !== grantId || body.operation !== "Fill"
    || body.secretPresent !== true || body.secretExposed !== false
    || actor.agentId !== "shellx-release-driver" || actor.origin !== VAULT_BROWSER_ORIGIN
    || typeof body.receiptId !== "string" || !body.receiptId.startsWith("vault-e2e-")) {
    throw new Error("Vault E2E probe returned the wrong mediated no-secret decision");
  }
}

function expectedVaultE2eAction(path: string): string {
  const actions: Record<string, string> = {
    "/vault/e2e/reset": "vaultE2eReset",
    "/vault/e2e/seed-secret": "vaultE2eSecretSeeded",
    "/vault/e2e/approve-grant": "vaultE2eGrantApproved",
    "/vault/e2e/deny-grant": "vaultE2eGrantDenied",
    "/vault/e2e/revoke-grant": "vaultE2eGrantRevoked",
    "/vault/e2e/expire-grant": "vaultE2eGrantExpired",
    "/vault/e2e/probe-use": "vaultE2eSecretUseProbed",
  };
  const action = actions[path];
  if (!action) throw new Error(`missing Vault E2E action for ${path}`);
  return action;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} did not return an object`);
  return value as Record<string, unknown>;
}

function requireExactKeys(body: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(body).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} returned unexpected keys: ${actual.join(", ")}`);
  }
}
