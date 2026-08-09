import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type JsonObject = Record<string, unknown>;

type WebDriverResponse = {
  value?: unknown;
};

type WebDriverCall = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<WebDriverResponse>;

export type VaultAgentRequestEvidence = {
  buildCommit: string;
  requestId: string;
  requestDigest: string;
  actorId: string;
  program: string;
  bindingEnv: string;
  status: string;
  success: boolean;
  exitCode: number | null;
  outputRedacted: boolean;
  trustedWebDriverClick: true;
};

const W3C_ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

function objectValue(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function stringValue(value: JsonObject, key: string, label: string): string {
  const result = value[key];
  if (typeof result !== "string" || !result) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return result;
}

function readTrim(path: string): string {
  const value = readFileSync(path, "utf8").trim();
  if (!value) throw new Error(`Expected a non-empty file: ${path}`);
  return value;
}

async function api(
  base: string,
  token: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<JsonObject> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path} failed ${response.status}: ${text.slice(0, 1_000)}`);
  }
  return objectValue(text ? JSON.parse(text) : {}, `${method} ${path} response`);
}

async function waitFor<T>(
  label: string,
  operation: () => Promise<T | null>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result !== null) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `${label} timed out${lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ""}`,
  );
}

function elementId(response: WebDriverResponse, label: string): string {
  const value = objectValue(response.value, `${label} value`);
  return stringValue(value, W3C_ELEMENT_KEY, label);
}

async function findElement(
  webdriver: WebDriverCall,
  sessionId: string,
  selector: string,
  parentElementId?: string,
): Promise<string> {
  const path = parentElementId
    ? `/session/${sessionId}/element/${encodeURIComponent(parentElementId)}/element`
    : `/session/${sessionId}/element`;
  const response = await webdriver("POST", path, {
    using: "css selector",
    value: selector,
  });
  return elementId(response, `WebDriver element ${selector}`);
}

async function elementText(
  webdriver: WebDriverCall,
  sessionId: string,
  id: string,
): Promise<string> {
  const response = await webdriver(
    "GET",
    `/session/${sessionId}/element/${encodeURIComponent(id)}/text`,
  );
  return String(response.value ?? "");
}

async function clickElement(
  webdriver: WebDriverCall,
  sessionId: string,
  id: string,
): Promise<void> {
  await webdriver(
    "POST",
    `/session/${sessionId}/element/${encodeURIComponent(id)}/click`,
    {},
  );
}

export async function runVaultAgentRequestWebdriverGate(options: {
  webdriver: WebDriverCall;
  sessionId: string;
  shellxHome: string;
  expectedBuildCommit?: string;
  program?: string;
}): Promise<VaultAgentRequestEvidence> {
  if (process.env.SHELLX_VAULT_E2E !== "1") {
    throw new Error("Vault agent-request WebDriver gate requires SHELLX_VAULT_E2E=1");
  }
  const configuredProfile = process.env.SHELLX_VAULT_PROFILE_DIR?.trim();
  if (!configuredProfile) {
    throw new Error("Vault agent-request WebDriver gate requires a disposable SHELLX_VAULT_PROFILE_DIR");
  }
  const debugPort = readTrim(join(options.shellxHome, "debug-api.port"));
  const token = readTrim(join(options.shellxHome, "shellxagent.token"));
  const base = `http://127.0.0.1:${debugPort}`;
  const health = await api(base, token, "GET", "/health");
  const buildCommit = stringValue(health, "buildCommit", "health");
  if (options.expectedBuildCommit) {
    if (buildCommit !== options.expectedBuildCommit) {
      throw new Error(`Vault acceptance build commit mismatch: ${buildCommit}`);
    }
  }

  await api(base, token, "POST", "/vault/e2e/reset", {});
  const suffix = randomUUID();
  const actorId = `vault-webdriver-${suffix}`;
  const resourceId = `000-smoke/vault-agent-request-${suffix}`;
  const secret = `SHELLX_VAULT_ACCEPTANCE_${suffix}`;
  const bindingEnv = "SHELLX_VAULT_ACCEPTANCE_SECRET";
  const program = options.program ?? "/usr/bin/printenv";
  let requestId: string | null = null;
  let requestDigest: string | null = null;

  try {
    const seeded = await api(base, token, "POST", "/vault/set", {
      key: resourceId,
      value: secret,
      description: "Disposable installed Vault executable-request acceptance resource",
      userOnly: false,
    });
    if (seeded.secretExposed === true || JSON.stringify(seeded).includes(secret)) {
      throw new Error("Vault seed response exposed the disposable secret");
    }

    const submitted = await api(base, token, "POST", "/vault/agent-requests", {
      actorId,
      actorLabel: "Installed Vault WebDriver gate",
      spec: {
        purpose: "Verify trusted owner approval and redacted environment injection",
        program,
        args: [bindingEnv],
        cwd: null,
        bindings: [{ resourceId, field: "value", env: bindingEnv }],
        timeoutMs: 15_000,
      },
    });
    const submittedRequest = objectValue(submitted.request, "submitted request");
    requestId = stringValue(submittedRequest, "requestId", "submitted request");
    requestDigest = stringValue(submittedRequest, "requestDigest", "submitted request");
    if (JSON.stringify(submitted).includes(secret)) {
      throw new Error("Vault request response exposed the disposable secret");
    }

    const header = await waitFor("Vault Request Center header", async () => {
      try {
        return await findElement(
          options.webdriver,
          options.sessionId,
          "[data-debug-id='header-vault-request-center']",
        );
      } catch {
        return null;
      }
    });
    await clickElement(options.webdriver, options.sessionId, header);

    const requestSelector = `[data-request-id="vault-agent-request:${requestId}"]`;
    const requestCard = await waitFor("Vault executable request card", async () => {
      try {
        return await findElement(options.webdriver, options.sessionId, requestSelector);
      } catch {
        return null;
      }
    });
    const detail = await elementText(options.webdriver, options.sessionId, requestCard);
    for (const expected of [program, bindingEnv, resourceId, "Run", "Deny"]) {
      if (!detail.includes(expected)) {
        throw new Error(`Vault Request Center omitted reviewed detail: ${expected}`);
      }
    }
    if (detail.includes(secret)) {
      throw new Error("Vault Request Center exposed the disposable secret");
    }

    const runButton = await findElement(
      options.webdriver,
      options.sessionId,
      "[data-debug-id='vault-request-action-approveVaultAgentRequest']",
      requestCard,
    );
    await clickElement(options.webdriver, options.sessionId, runButton);

    const completed = await waitFor("approved Vault executable request", async () => {
      const snapshot = await api(
        base,
        token,
        "GET",
        `/vault/agent-requests?actorId=${encodeURIComponent(actorId)}`,
      );
      if (JSON.stringify(snapshot).includes(secret)) {
        throw new Error("Vault request snapshot exposed the disposable secret");
      }
      const requests = Array.isArray(snapshot.requests) ? snapshot.requests : [];
      const match = requests
        .map((value) => objectValue(value, "Vault request snapshot entry"))
        .find((value) => value.requestId === requestId);
      return match?.status === "completed" ? match : null;
    }, 20_000);
    const result = objectValue(completed.result, "completed Vault request result");
    const stdout = stringValue(result, "stdout", "completed Vault request result");
    const success = result.success === true;
    const exitCode = typeof result.exitCode === "number" ? result.exitCode : null;
    const outputRedacted = stdout.includes("[REDACTED BY VAULT]") && !stdout.includes(secret);
    if (!success || exitCode !== 0 || !outputRedacted) {
      throw new Error("Vault approved command did not complete with redacted injected output");
    }

    return {
      buildCommit,
      requestId,
      requestDigest,
      actorId,
      program,
      bindingEnv,
      status: stringValue(completed, "status", "completed Vault request"),
      success,
      exitCode,
      outputRedacted,
      trustedWebDriverClick: true,
    };
  } finally {
    if (requestId) {
      const snapshot = await api(
        base,
        token,
        "GET",
        `/vault/agent-requests?actorId=${encodeURIComponent(actorId)}`,
      ).catch(() => null);
      const requests = snapshot && Array.isArray(snapshot.requests) ? snapshot.requests : [];
      const pending = requests
        .map((value) => objectValue(value, "Vault cleanup request"))
        .some((value) => value.requestId === requestId && value.status === "pending");
      if (pending) {
        await api(base, token, "POST", `/vault/agent-requests/${encodeURIComponent(requestId)}/cancel`, {
          actorId,
        }).catch(() => undefined);
      }
    }
    await api(base, token, "POST", "/vault/delete", { key: resourceId }).catch(() => undefined);
    await api(base, token, "POST", "/vault/e2e/reset", {}).catch(() => undefined);
  }
}
