import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import { isDeepStrictEqual } from "node:util";

const VAULT_AGENT_REQUEST_MUTATIONS = new Set([
  "POST /vault/agent-requests",
  "POST /vault/agent-requests/:request_id/cancel",
]);

const TIMEOUT_MS = 30_000;

type DebugApiConnection = { base: string; token: string };
type DriverAssignment = ReleaseSurfaceDriverRequest["assignments"][number];

export function isDebugApiVaultAgentRequestMutation(name: string): boolean {
  return VAULT_AGENT_REQUEST_MUTATIONS.has(name);
}

export async function exerciseDebugApiVaultAgentRequestMutation(
  connection: DebugApiConnection,
  request: ReleaseSurfaceDriverRequest,
  assignment: DriverAssignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome: ReleaseSurfaceDriverOutcome = {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No exact isolated Vault agent-request lifecycle was observed.",
  };
  const segment = request.sourceCommit.slice(0, 16);
  const secretRef = `release-surface/e2e/agent-request/${segment}`;
  const secretValue = `SHELLX_RELEASE_VAULT_E2E_SECRET_${request.sourceCommit}`;
  const actorId = `shellx-release-agent-${segment}`;
  const actorLabel = `ShellX release agent ${segment}`;
  const purpose = `Verify exact Vault agent request ${segment}`;
  try {
    if (!VAULT_AGENT_REQUEST_MUTATIONS.has(assignment.surface.name)) {
      throw new Error(`unsupported Vault agent-request route ${assignment.surface.name}`);
    }
    await resetVaultE2e(connection, secretValue);
    await verifyEmptyAgentRequestState(connection, secretValue);
    await seedSecret(connection, secretRef, secretValue);
    outcome.present = "pass";

    const createdBody = await apiJson(connection, "POST", "/vault/agent-requests", {
      actorId,
      actorLabel,
      spec: {
        purpose,
        program: request.runtime.installedPayloadPath,
        args: [],
        cwd: null,
        bindings: [{
          resourceId: secretRef,
          field: "value",
          env: "SHELLX_RELEASE_VAULT_TOKEN",
        }],
        timeoutMs: 5_000,
      },
    }, secretValue);
    verifyExactKeys(createdBody, ["ok", "request", "secretExposed", "status"], "Vault agent-request create response");
    const created = requireObject(createdBody.request, "Vault agent-request create row");
    verifyAgentRequest(created, {
      actorId,
      actorLabel,
      purpose,
      program: request.runtime.installedPayloadPath,
      secretRef,
      status: "pending",
      platform: request.platform,
    });
    const requestId = requiredString(created.requestId, "Vault agent requestId");
    if (createdBody.ok !== true || createdBody.status !== "pendingOperatorApproval"
      || createdBody.secretExposed !== false || !requestId.startsWith("request-")) {
      throw new Error("Vault agent-request create response omitted its exact mediated pending state");
    }

    let expected = created;
    if (assignment.surface.name === "POST /vault/agent-requests/:request_id/cancel") {
      const cancelledBody = await apiJson(
        connection,
        "POST",
        `/vault/agent-requests/${encodeURIComponent(requestId)}/cancel`,
        { actorId },
        secretValue,
      );
      verifyExactKeys(cancelledBody, ["ok", "request", "secretExposed"], "Vault agent-request cancel response");
      const cancelled = requireObject(cancelledBody.request, "Vault agent-request cancelled row");
      verifyAgentRequest(cancelled, {
        actorId,
        actorLabel,
        purpose,
        program: request.runtime.installedPayloadPath,
        secretRef,
        status: "cancelled",
        platform: request.platform,
      });
      if (cancelledBody.ok !== true || cancelledBody.secretExposed !== false
        || cancelled.requestId !== requestId || cancelled.requestDigest !== created.requestDigest
        || cancelled.decisionReason !== "cancelled by requesting agent"
        || !Number.isSafeInteger(cancelled.decidedAtMs)
        || !Number.isSafeInteger(cancelled.completedAtMs)
        || Number(cancelled.decidedAtMs) < Number(created.createdAtMs)
        || cancelled.decidedAtMs !== cancelled.completedAtMs) {
        throw new Error("Vault agent-request cancel did not terminate the exact owned pending request");
      }
      expected = cancelled;
    }
    outcome.invoke = "pass";

    const snapshot = await readAgentRequests(connection, actorId, secretValue);
    const rows = requireObjectArray(snapshot.requests, "Vault agent-request snapshot rows");
    const resources = requireObjectArray(snapshot.resources, "Vault agent-request snapshot resources");
    const matches = rows.filter((row) => row.requestId === requestId);
    if (matches.length !== 1 || !isDeepStrictEqual(matches[0], expected)
      || snapshot.pendingCount !== (assignment.surface.name === "POST /vault/agent-requests" ? 1 : 0)) {
      throw new Error("Vault agent-request center did not read back the exact owned lifecycle row");
    }
    if (resources.length !== 1) throw new Error("Vault agent-request resource catalog was not exact");
    verifyExactKeys(resources[0]!, ["fields", "id", "kind", "label", "permission", "updatedAtMs"], "Vault agent-request resource");
    if (resources[0]?.id !== secretRef || resources[0]?.label !== secretRef
      || resources[0]?.kind !== "secret" || resources[0]?.permission !== "visibleAsk"
      || JSON.stringify(resources[0]?.fields) !== JSON.stringify(["value"])
      || !Number.isSafeInteger(resources[0]?.updatedAtMs)) {
      throw new Error("Vault agent-request resource catalog exposed more than exact metadata");
    }

    outcome.effect = "pass";
    outcome.observedEffect = assignment.surface.name === "POST /vault/agent-requests"
      ? "POST /vault/agent-requests created and read back one exact metadata-only pending request for an installed executable without executing it or exposing a secret; isolated state was reset."
      : "POST /vault/agent-requests/:request_id/cancel terminated and read back the exact owned pending request without executing it or exposing a secret; isolated state was reset.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await resetVaultE2e(connection, secretValue);
      await verifyEmptyAgentRequestState(connection, secretValue);
      const audit = await apiJson(connection, "GET", "/vault/e2e/audit", undefined, secretValue);
      const rows = requireObjectArray(audit.audit, "Vault E2E cleanup audit");
      if (rows.length !== 1 || rows[0]?.action !== "vaultE2eReset" || rows[0]?.secretExposed !== false
        || rows[0]?.secretRef !== null || rows[0]?.grantId !== null || rows[0]?.reason !== null) {
        throw new Error("Vault agent-request cleanup did not restore the exact isolated reset audit baseline");
      }
      outcome.cleanup = "pass";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return outcome;
}

async function seedSecret(
  connection: DebugApiConnection,
  secretRef: string,
  secretValue: string,
): Promise<void> {
  const response = await apiJson(connection, "POST", "/vault/e2e/seed-secret", {
    secretRef,
    value: secretValue,
  }, secretValue);
  if (response.ok !== true || response.secretRef !== secretRef
    || response.secretPresent !== true || response.secretExposed !== false) {
    throw new Error("Vault agent-request prerequisite secret was not seeded exactly");
  }
}

async function resetVaultE2e(connection: DebugApiConnection, secretValue: string): Promise<void> {
  const response = await apiJson(connection, "POST", "/vault/e2e/reset", {}, secretValue);
  const receipt = requireObject(response.receipt, "Vault E2E reset receipt");
  if (response.ok !== true || receipt.action !== "vaultE2eReset" || receipt.secretExposed !== false
    || receipt.reason !== null) throw new Error("Vault E2E reset did not succeed without cleanup warnings");
}

async function verifyEmptyAgentRequestState(
  connection: DebugApiConnection,
  secretValue: string,
): Promise<void> {
  const snapshot = await readAgentRequests(connection, null, secretValue);
  if (snapshot.pendingCount !== 0
    || requireObjectArray(snapshot.requests, "Vault empty agent requests").length !== 0
    || requireObjectArray(snapshot.resources, "Vault empty agent resources").length !== 0) {
    throw new Error("Vault E2E reset retained agent requests or resource metadata");
  }
}

async function readAgentRequests(
  connection: DebugApiConnection,
  actorId: string | null,
  secretValue: string,
): Promise<Record<string, unknown>> {
  const path = actorId
    ? `/vault/agent-requests?actorId=${encodeURIComponent(actorId)}`
    : "/vault/agent-requests";
  const response = await apiJson(connection, "GET", path, undefined, secretValue);
  verifyExactKeys(response, ["pendingCount", "requests", "resources"], "Vault agent-request center snapshot");
  return response;
}

function verifyAgentRequest(
  request: Record<string, unknown>,
  expected: {
    actorId: string;
    actorLabel: string;
    purpose: string;
    program: string;
    secretRef: string;
    status: "pending" | "cancelled";
    platform: ReleaseSurfaceDriverRequest["platform"];
  },
): void {
  verifyExactKeys(request, [
    "actorId", "actorLabel", "completedAtMs", "createdAtMs", "decidedAtMs", "decisionReason",
    "deviceId", "expiresAtMs", "grantIds", "requestDigest", "requestId", "result", "spec", "status",
  ], "Vault agent-request row");
  const spec = requireObject(request.spec, "Vault agent-request spec");
  verifyExactKeys(spec, ["args", "bindings", "cwd", "program", "purpose", "timeoutMs"], "Vault agent-request spec");
  const bindings = requireObjectArray(spec.bindings, "Vault agent-request bindings");
  const grantIds = Array.isArray(request.grantIds) ? request.grantIds : [];
  const os = expected.platform === "windows-installed"
    ? "windows"
    : expected.platform === "macos-installed" ? "macos" : "linux";
  if (request.actorId !== expected.actorId || request.actorLabel !== expected.actorLabel
    || request.deviceId !== `shellx-desktop-${os}` || request.status !== expected.status
    || !requiredString(request.requestId, "Vault agent requestId").startsWith("request-")
    || !/^[a-f0-9]{64}$/.test(requiredString(request.requestDigest, "Vault agent requestDigest"))
    || !Number.isSafeInteger(request.createdAtMs) || !Number.isSafeInteger(request.expiresAtMs)
    || Number(request.expiresAtMs) - Number(request.createdAtMs) !== 300_000
    || grantIds.length !== 1 || !requiredString(grantIds[0], "Vault agent grantId")
    || spec.purpose !== expected.purpose || spec.program !== expected.program
    || JSON.stringify(spec.args) !== "[]" || spec.cwd !== null || spec.timeoutMs !== 5_000
    || bindings.length !== 1 || bindings[0]?.resourceId !== expected.secretRef
    || bindings[0]?.field !== "value" || bindings[0]?.env !== "SHELLX_RELEASE_VAULT_TOKEN"
    || request.result !== null) {
    throw new Error(`Vault agent-request row did not match its exact ${expected.status} contract`);
  }
  if (expected.status === "pending" && (request.decidedAtMs !== null || request.completedAtMs !== null
    || request.decisionReason !== null)) {
    throw new Error("Vault pending agent request contained terminal decision state");
  }
}

async function apiJson(
  connection: DebugApiConnection,
  method: "GET" | "POST",
  path: string,
  body: Record<string, unknown> | undefined,
  secretValue: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  if (secretValue && text.includes(secretValue)) throw new Error(`${method} ${path} exposed the isolated secret`);
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${text.slice(0, 1_200)}`);
  return requireObject(text.trim() ? JSON.parse(text) : {}, `${method} ${path}`);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} did not return an object`);
  return value as Record<string, unknown>;
}

function requireObjectArray(value: unknown, label: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error(`${label} did not return an array`);
  return value.map((entry, index) => requireObject(entry, `${label}[${index}]`));
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function verifyExactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} keys changed: ${actual.join(", ")}`);
  }
}
