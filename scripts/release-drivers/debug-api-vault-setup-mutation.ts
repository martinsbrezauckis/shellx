import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";

const VAULT_SETUP_MUTATIONS = new Set([
  "POST /vault/setup/begin",
  "POST /vault/setup/confirm-recovery",
  "POST /vault/lock",
  "POST /vault/remember-device",
]);

const TIMEOUT_MS = 30_000;

type DebugApiConnection = { base: string; token: string };
type DriverAssignment = ReleaseSurfaceDriverRequest["assignments"][number];

type VaultStatus = {
  mode: "unconfigured" | "local" | "external";
  unlocked: boolean;
  recoveryConfirmed: boolean;
  rememberedDeviceEnabled: boolean;
};

type RecoveryKitIdentity = {
  confirmationId: string;
  words: string[];
};

export function isDebugApiVaultSetupMutation(name: string): boolean {
  return VAULT_SETUP_MUTATIONS.has(name);
}

export async function exerciseDebugApiVaultSetupMutation(
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
    observedEffect: "No isolated Vault setup lifecycle effect was observed.",
  };
  const passphrase = `ShellX-Release-Vault-${request.sourceCommit}`;
  try {
    if (!VAULT_SETUP_MUTATIONS.has(assignment.surface.name)) {
      throw new Error(`unsupported Vault setup route ${assignment.surface.name}`);
    }
    await resetAndVerifyVaultBaseline(connection, passphrase);
    const kit = await beginVaultSetup(connection, passphrase);
    outcome.present = "pass";

    if (assignment.surface.name === "POST /vault/setup/begin") {
      outcome.invoke = "pass";
      await confirmVaultRecovery(connection, kit.confirmationId, passphrase);
      verifyConfiguredStatus(await readVaultStatus(connection), true);
      outcome.effect = "pass";
      outcome.observedEffect = "POST /vault/setup/begin created one valid local recovery challenge inside the disposable Vault profile; successful confirmation proved the pending setup without retaining its passphrase, recovery words, or confirmation identity.";
    } else if (assignment.surface.name === "POST /vault/setup/confirm-recovery") {
      await confirmVaultRecovery(connection, kit.confirmationId, passphrase);
      outcome.invoke = "pass";
      verifyConfiguredStatus(await readVaultStatus(connection), true);
      outcome.effect = "pass";
      outcome.observedEffect = "POST /vault/setup/confirm-recovery activated the exact pending local Vault with recovery confirmed, no legacy import, and remembered-device storage disabled; recovery and credential material were not retained.";
    } else if (assignment.surface.name === "POST /vault/remember-device") {
      await confirmVaultRecovery(connection, kit.confirmationId, passphrase);
      verifyConfiguredStatus(await readVaultStatus(connection), true);
      const enabled = await postJson(connection, "/vault/remember-device", {
        enabled: true,
        passphrase,
      }, [passphrase, ...kit.words]);
      outcome.invoke = "pass";
      verifyExactKeys(enabled, ["enabled", "ok"], "POST /vault/remember-device enable");
      if (enabled.ok !== true || enabled.enabled !== true) {
        throw new Error("POST /vault/remember-device did not enable the exact disposable device");
      }
      verifyConfiguredRememberedStatus(await readVaultStatus(connection), true);
      const disabled = await postJson(connection, "/vault/remember-device", {
        enabled: false,
      }, [passphrase, ...kit.words]);
      verifyExactKeys(disabled, ["enabled", "ok"], "POST /vault/remember-device disable");
      if (disabled.ok !== true || disabled.enabled !== false) {
        throw new Error("POST /vault/remember-device did not forget the exact disposable device");
      }
      verifyConfiguredRememberedStatus(await readVaultStatus(connection), false);
      outcome.effect = "pass";
      outcome.observedEffect = "POST /vault/remember-device enabled the OS-backed remembered-device credential for the exact disposable local Vault, verified metadata, then deleted that credential and read back disabled state without retaining passphrase, recovery, or device material.";
    } else {
      await confirmVaultRecovery(connection, kit.confirmationId, passphrase);
      verifyConfiguredStatus(await readVaultStatus(connection), true);
      const locked = await postJson(connection, "/vault/lock", {}, [passphrase, ...kit.words]);
      outcome.invoke = "pass";
      verifyExactKeys(locked, ["ok", "rememberedDeviceEnabled", "unlocked"], "POST /vault/lock");
      if (locked.ok !== true || locked.unlocked !== false || locked.rememberedDeviceEnabled !== false) {
        throw new Error("POST /vault/lock did not return the exact locked non-remembered state");
      }
      verifyConfiguredStatus(await readVaultStatus(connection), false);
      outcome.effect = "pass";
      outcome.observedEffect = "POST /vault/lock removed the active session from the exact disposable local Vault while preserving recovery confirmation and disabled remembered-device state; credential material was not retained.";
    }
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await resetAndVerifyVaultBaseline(connection, passphrase);
      outcome.cleanup = "pass";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return outcome;
}

async function beginVaultSetup(
  connection: DebugApiConnection,
  passphrase: string,
): Promise<RecoveryKitIdentity> {
  const body = await postJson(connection, "/vault/setup/begin", {
    target: "local",
    passphrase,
    rememberDevice: false,
  }, [passphrase]);
  verifyExactKeys(body, ["ok", "recoveryKit"], "POST /vault/setup/begin");
  const kit = requireObject(body.recoveryKit, "Vault recovery kit");
  verifyExactKeys(kit, ["confirmationId", "warning", "words"], "Vault recovery kit");
  if (body.ok !== true || typeof kit.confirmationId !== "string" || !/^[0-9a-f]{32}$/.test(kit.confirmationId)
    || kit.warning !== "Save this recovery kit. ShellX cannot recover the vault without it."
    || !Array.isArray(kit.words) || kit.words.length !== 16
    || kit.words.some((word) => typeof word !== "string" || !/^[0-9a-f]{4}$/.test(word))) {
    throw new Error("POST /vault/setup/begin returned an invalid local recovery challenge shape");
  }
  return { confirmationId: kit.confirmationId, words: [...kit.words] as string[] };
}

async function confirmVaultRecovery(
  connection: DebugApiConnection,
  confirmationId: string,
  passphrase: string,
): Promise<void> {
  const body = await postJson(connection, "/vault/setup/confirm-recovery", {
    confirmationId,
    importLegacy: false,
  }, [passphrase, confirmationId]);
  verifyExactKeys(body, ["legacyImport", "ok"], "POST /vault/setup/confirm-recovery");
  const receipt = requireObject(body.legacyImport, "Vault legacy import receipt");
  verifyExactKeys(receipt, ["backupPath", "completedAtMs", "importedKeys", "skipped"], "Vault legacy import receipt");
  if (body.ok !== true || receipt.importedKeys !== 0 || receipt.skipped !== true
    || receipt.backupPath !== null || !Number.isSafeInteger(receipt.completedAtMs)
    || Number(receipt.completedAtMs) <= 0) {
    throw new Error("Vault recovery confirmation did not preserve the exact no-legacy-import contract");
  }
}

async function resetAndVerifyVaultBaseline(
  connection: DebugApiConnection,
  privateValue: string,
): Promise<void> {
  const reset = await postJson(connection, "/vault/e2e/reset", {}, [privateValue]);
  verifyExactKeys(reset, ["ok", "receipt"], "POST /vault/e2e/reset");
  const receipt = requireObject(reset.receipt, "Vault E2E reset receipt");
  verifyExactKeys(receipt, [
    "action", "decision", "grantId", "reason", "receiptId", "secretExposed",
    "secretPresent", "secretRef", "t",
  ], "Vault E2E reset receipt");
  if (reset.ok !== true || receipt.action !== "vaultE2eReset" || receipt.secretExposed !== false
    || receipt.reason !== null) {
    throw new Error("Vault E2E reset did not return its exact redacted reset receipt");
  }
  const auditResponse = await getJson(connection, "/vault/e2e/audit", [privateValue]);
  verifyExactKeys(auditResponse, ["audit", "ok", "secretExposed"], "GET /vault/e2e/audit");
  const audit = requireObjectArray(auditResponse.audit, "Vault E2E reset audit");
  if (auditResponse.ok !== true || auditResponse.secretExposed !== false || audit.length !== 1
    || audit[0]?.action !== "vaultE2eReset" || audit[0]?.secretExposed !== false
    || audit[0]?.secretRef !== null || audit[0]?.grantId !== null
    || audit[0]?.decision !== null || audit[0]?.secretPresent !== null || audit[0]?.reason !== null) {
    throw new Error("Vault E2E reset did not restore its exact single-row redacted audit baseline");
  }
  const status = await readVaultStatus(connection);
  if (status.mode !== "unconfigured" || status.unlocked !== false || status.recoveryConfirmed !== false
    || status.rememberedDeviceEnabled !== true) {
    throw new Error("Vault E2E reset did not restore the exact unconfigured disposable baseline");
  }
}

async function readVaultStatus(connection: DebugApiConnection): Promise<VaultStatus> {
  const body = await getJson(connection, "/vault/status", []);
  verifyExactKeys(body, [
    "activeGrants", "lastError", "legacyVaultDetected", "mode", "pendingDeposits",
    "recoveryConfirmed", "rememberedDeviceEnabled", "syncPending", "unlocked",
  ], "GET /vault/status");
  if (!["unconfigured", "local", "external"].includes(String(body.mode))
    || typeof body.unlocked !== "boolean" || typeof body.recoveryConfirmed !== "boolean"
    || typeof body.rememberedDeviceEnabled !== "boolean" || body.legacyVaultDetected !== false
    || body.activeGrants !== 0 || body.pendingDeposits !== 0 || body.syncPending !== false
    || body.lastError !== null) {
    throw new Error("GET /vault/status returned an invalid isolated metadata-only state");
  }
  return body as VaultStatus;
}

function verifyConfiguredStatus(status: VaultStatus, unlocked: boolean): void {
  if (status.mode !== "local" || status.unlocked !== unlocked || status.recoveryConfirmed !== true
    || status.rememberedDeviceEnabled !== false) {
    throw new Error(`Vault status did not prove the exact configured ${unlocked ? "unlocked" : "locked"} local state`);
  }
}

function verifyConfiguredRememberedStatus(status: VaultStatus, remembered: boolean): void {
  if (status.mode !== "local" || status.unlocked !== true || status.recoveryConfirmed !== true
    || status.rememberedDeviceEnabled !== remembered) {
    throw new Error(`Vault status did not prove remembered-device ${remembered ? "enable" : "disable"}`);
  }
}

async function postJson(
  connection: DebugApiConnection,
  path: string,
  body: Record<string, unknown>,
  privateValues: string[],
): Promise<Record<string, unknown>> {
  return requestJson(connection, "POST", path, body, privateValues);
}

async function getJson(
  connection: DebugApiConnection,
  path: string,
  privateValues: string[],
): Promise<Record<string, unknown>> {
  return requestJson(connection, "GET", path, undefined, privateValues);
}

async function requestJson(
  connection: DebugApiConnection,
  method: "GET" | "POST",
  path: string,
  body: Record<string, unknown> | undefined,
  privateValues: string[],
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
  if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}`);
  for (const value of privateValues) {
    if (value && text.includes(value)) throw new Error(`${method} ${path} exposed private setup material`);
  }
  try {
    return requireObject(text.trim() ? JSON.parse(text) : {}, `${method} ${path}`);
  } catch {
    throw new Error(`${method} ${path} returned invalid JSON`);
  }
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} did not return an object`);
  return value as Record<string, unknown>;
}

function requireObjectArray(value: unknown, label: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error(`${label} did not return an array`);
  return value.map((entry, index) => requireObject(entry, `${label}[${index}]`));
}

function verifyExactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} keys changed: ${actual.join(", ")}`);
  }
}
