import { createHash, randomBytes } from "node:crypto";
import type { ReleaseSurfaceCandidateAttestation, ReleaseSurfaceFileIdentity } from "./release-surface-candidate-attestation";
import type { ReleasePlatform, ReleaseSurfaceKind } from "./release-surface-inventory";

export const RELEASE_SURFACE_WEBDRIVER_BINDING_SCHEMA =
  "shellx/release-surface-webdriver-binding@2";

const NATIVE_WEBDRIVER_KINDS = new Set<ReleaseSurfaceKind>([
  "ui-control",
  "palette-action",
  "keyboard-shortcut",
]);
const NATIVE_WEBDRIVER_DRIVER_IDS = new Set([
  "shellx-command-installed",
  "ui-debug-surface-vault-request-prompt-installed",
  "ui-debug-surface-trusted-vault-fill-installed",
]);
const MACOS_NATIVE_INPUT_DRIVER_IDS = new Set([
  "shellx-command-installed",
  "ui-debug-surface-vault-request-prompt-installed",
  "ui-control-trusted-vault-fill-installed",
  "ui-debug-surface-trusted-vault-fill-installed",
]);
export function releaseSurfaceDriverRequiresNativeWebDriver(
  driverId: string,
  kind: ReleaseSurfaceKind,
  platform?: ReleasePlatform,
): boolean {
  if (platform === "macos-installed" && releaseSurfaceDriverSupportsMacosNativeInput(driverId, kind)) {
    return false;
  }
  return NATIVE_WEBDRIVER_KINDS.has(kind) || NATIVE_WEBDRIVER_DRIVER_IDS.has(driverId);
}

export function releaseSurfaceDriverSupportsMacosNativeInput(
  driverId: string,
  kind: ReleaseSurfaceKind,
): boolean {
  return NATIVE_WEBDRIVER_KINDS.has(kind) || MACOS_NATIVE_INPUT_DRIVER_IDS.has(driverId);
}

export interface ReleaseSurfaceWebDriverSession {
  base: string;
  sessionId: string;
}

export interface ReleaseSurfaceWebDriverRequestBinding extends ReleaseSurfaceWebDriverSession {
  evidence: ReleaseSurfaceFileIdentity;
}

export interface ReleaseSurfaceWebDriverBindingEvidence {
  schema: typeof RELEASE_SURFACE_WEBDRIVER_BINDING_SCHEMA;
  mode: "final-frozen-candidate";
  platform: ReleaseSurfaceCandidateAttestation["platform"];
  sourceCommit: string;
  version: string;
  createdAt: string;
  candidate: {
    processId: number;
    instanceId: string;
    debugBase: string;
  };
  webdriver: {
    base: string;
    sessionIdSha256: string;
    titleSha256: string;
    titleBytes: number;
  };
  challenge: {
    id: string;
    selector: "body";
    labelSha256: string;
    sourceSha256: string;
    sourceBytes: number;
    candidateReportedResolved: true;
    webdriverObservedLabel: true;
    candidateReportedCleared: true;
    webdriverObservedCleared: true;
  };
}

type Fetch = typeof fetch;

export async function proveReleaseSurfaceWebDriverBinding(input: {
  candidate: ReleaseSurfaceCandidateAttestation;
  candidateToken: string;
  session: ReleaseSurfaceWebDriverSession;
  fetchImpl?: Fetch;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<ReleaseSurfaceWebDriverBindingEvidence> {
  const { candidate, candidateToken, session } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 20_000;
  const pollMs = input.pollMs ?? 100;
  const webdriverBase = parseExactReleaseSurfaceWebDriverBase(session.base);
  if (!webdriverBase) throw new Error("WebDriver base must be an exact http://127.0.0.1:<port> origin");
  if (!/^[a-zA-Z0-9._:-]{8,256}$/.test(session.sessionId)) {
    throw new Error("WebDriver session id must be a bounded opaque identifier");
  }
  if (candidateToken.trim().length < 32) throw new Error("candidate Debug API token is invalid");

  const challengeNonce = randomBytes(24).toString("hex");
  const challengeId = `final-native-binding-${challengeNonce}`;
  const challengeLabel = `shellx-native-binding-${challengeNonce}`;
  const candidateBase = candidate.runtime.debugBase.replace(/\/$/, "");
  const title = String(await webdriverValue(fetchImpl, session, "GET", "/title"));
  let source = "";
  let candidateResolved = false;
  let webdriverObserved = false;
  let candidateCleared = false;
  let webdriverCleared = false;
  try {
    await candidateJson(fetchImpl, candidateBase, candidateToken, "POST", "/state/ui", {
      debugSurface: "app",
      source: "final-surface-webdriver-binding",
      debugHighlights: [{ id: challengeId, selector: "body", label: challengeLabel, color: "cyan" }],
    });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await candidateJson(fetchImpl, candidateBase, candidateToken, "GET", "/state/ui") as {
        debugHighlightResults?: Array<{ id?: string; status?: string }>;
        debugHighlightResultsBySurface?: Record<string, Array<{ id?: string; status?: string }>>;
      };
      const results = state.debugHighlightResultsBySurface?.app ?? state.debugHighlightResults ?? [];
      candidateResolved = results.some((result) => result.id === challengeId && result.status === "resolved");
      source = String(await webdriverValue(fetchImpl, session, "GET", "/source"));
      webdriverObserved = source.includes(challengeLabel);
      if (candidateResolved && webdriverObserved) break;
      await delay(pollMs);
    }
    if (!candidateResolved || !webdriverObserved) {
      throw new Error("WebDriver session did not observe the exact candidate-rendered binding challenge");
    }
  } finally {
    await candidateJson(fetchImpl, candidateBase, candidateToken, "POST", "/state/ui", {
      debugSurface: "app",
      source: "final-surface-webdriver-binding-cleanup",
      debugHighlights: [],
    });
    const cleanupDeadline = Date.now() + Math.min(timeoutMs, 5_000);
    while (Date.now() < cleanupDeadline) {
      const state = await candidateJson(fetchImpl, candidateBase, candidateToken, "GET", "/state/ui") as {
        debugHighlightResults?: Array<{ id?: string }>;
        debugHighlightResultsBySurface?: Record<string, Array<{ id?: string }>>;
      };
      const results = state.debugHighlightResultsBySurface?.app ?? state.debugHighlightResults ?? [];
      candidateCleared = !results.some((result) => result.id === challengeId);
      const clearedSource = String(await webdriverValue(fetchImpl, session, "GET", "/source"));
      webdriverCleared = !clearedSource.includes(challengeLabel);
      if (candidateCleared && webdriverCleared) break;
      await delay(pollMs);
    }
  }
  if (!candidateCleared || !webdriverCleared) {
    throw new Error("WebDriver candidate binding challenge did not clean up completely");
  }
  return {
    schema: RELEASE_SURFACE_WEBDRIVER_BINDING_SCHEMA,
    mode: "final-frozen-candidate",
    platform: candidate.platform,
    sourceCommit: candidate.sourceCommit,
    version: candidate.version,
    createdAt: new Date().toISOString(),
    candidate: {
      processId: candidate.runtime.processId,
      instanceId: candidate.runtime.instanceId,
      debugBase: candidate.runtime.debugBase,
    },
    webdriver: {
      base: webdriverBase.origin,
      sessionIdSha256: sha256(session.sessionId),
      titleSha256: sha256(title),
      titleBytes: Buffer.byteLength(title),
    },
    challenge: {
      id: challengeId,
      selector: "body",
      labelSha256: sha256(challengeLabel),
      sourceSha256: sha256(source),
      sourceBytes: Buffer.byteLength(source),
      candidateReportedResolved: true,
      webdriverObservedLabel: true,
      candidateReportedCleared: true,
      webdriverObservedCleared: true,
    },
  };
}

export function validateReleaseSurfaceWebDriverBinding(input: {
  evidence: ReleaseSurfaceWebDriverBindingEvidence;
  candidate: ReleaseSurfaceCandidateAttestation;
  session: ReleaseSurfaceWebDriverSession;
}): string[] {
  const { evidence, candidate, session } = input;
  const errors: string[] = [];
  rejectUnknownKeys(evidence, [
    "schema", "mode", "platform", "sourceCommit", "version", "createdAt", "candidate", "webdriver", "challenge",
  ], "WebDriver binding", errors);
  rejectUnknownKeys(evidence.candidate, ["processId", "instanceId", "debugBase"], "WebDriver binding candidate", errors);
  rejectUnknownKeys(evidence.webdriver, [
    "base", "sessionIdSha256", "titleSha256", "titleBytes",
  ], "WebDriver binding session", errors);
  rejectUnknownKeys(evidence.challenge, [
    "id", "selector", "labelSha256", "sourceSha256", "sourceBytes", "candidateReportedResolved",
    "webdriverObservedLabel", "candidateReportedCleared", "webdriverObservedCleared",
  ], "WebDriver binding challenge", errors);
  if (evidence.schema !== RELEASE_SURFACE_WEBDRIVER_BINDING_SCHEMA) {
    errors.push(`WebDriver binding schema must be ${RELEASE_SURFACE_WEBDRIVER_BINDING_SCHEMA}`);
  }
  if (evidence.mode !== "final-frozen-candidate") errors.push("WebDriver binding mode must be final-frozen-candidate");
  for (const [field, expected, actual] of [
    ["platform", candidate.platform, evidence.platform],
    ["sourceCommit", candidate.sourceCommit, evidence.sourceCommit],
    ["version", candidate.version, evidence.version],
    ["processId", candidate.runtime.processId, evidence.candidate?.processId],
    ["instanceId", candidate.runtime.instanceId, evidence.candidate?.instanceId],
    ["debugBase", candidate.runtime.debugBase, evidence.candidate?.debugBase],
  ] as const) {
    if (actual !== expected) errors.push(`WebDriver binding ${field} does not match the exact candidate`);
  }
  if (!Number.isFinite(Date.parse(evidence.createdAt))) errors.push("WebDriver binding createdAt must be a valid ISO timestamp");
  const base = parseExactReleaseSurfaceWebDriverBase(session.base);
  if (!base || evidence.webdriver?.base !== base.origin) errors.push("WebDriver binding base does not match the exact loopback session");
  if (evidence.webdriver?.sessionIdSha256 !== sha256(session.sessionId)) {
    errors.push("WebDriver binding session hash does not match the exact session");
  }
  if (!/^[a-f0-9]{64}$/.test(evidence.webdriver?.titleSha256 ?? "")
    || !Number.isSafeInteger(evidence.webdriver?.titleBytes)
    || evidence.webdriver.titleBytes <= 0
    || evidence.webdriver.titleBytes > 4_096) {
    errors.push("WebDriver binding must record only a bounded observed window-title identity");
  }
  if (!/^final-native-binding-[a-f0-9]{48}$/.test(evidence.challenge?.id ?? "")) {
    errors.push("WebDriver binding challenge id is invalid");
  }
  if (evidence.challenge?.selector !== "body") errors.push("WebDriver binding challenge selector must be body");
  if (!/^[a-f0-9]{64}$/.test(evidence.challenge?.labelSha256 ?? "")
    || !/^[a-f0-9]{64}$/.test(evidence.challenge?.sourceSha256 ?? "")) {
    errors.push("WebDriver binding challenge hashes are invalid");
  }
  if (!Number.isSafeInteger(evidence.challenge?.sourceBytes) || evidence.challenge.sourceBytes <= 0) {
    errors.push("WebDriver binding source byte count must be positive");
  }
  for (const field of [
    "candidateReportedResolved",
    "webdriverObservedLabel",
    "candidateReportedCleared",
    "webdriverObservedCleared",
  ] as const) {
    if (evidence.challenge?.[field] !== true) errors.push(`WebDriver binding ${field} must be true`);
  }
  return errors;
}

export function parseExactReleaseSurfaceWebDriverBase(value: string | undefined): URL | null {
  if (!value || value.trim() !== value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) return null;
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    if (value !== url.origin && value !== `${url.origin}/`) return null;
    return url;
  } catch {
    return null;
  }
}

async function webdriverValue(
  fetchImpl: Fetch,
  session: ReleaseSurfaceWebDriverSession,
  method: "GET" | "POST",
  path: string,
): Promise<unknown> {
  const response = await fetchImpl(
    `${session.base.replace(/\/$/, "")}/session/${encodeURIComponent(session.sessionId)}${path}`,
    { method, signal: AbortSignal.timeout(3_000) },
  );
  if (!response.ok) throw new Error(`WebDriver ${method} ${path} returned ${response.status}: ${await response.text()}`);
  const body = await response.json() as { value?: unknown };
  return body.value;
}

async function candidateJson(
  fetchImpl: Fetch,
  base: string,
  token: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetchImpl(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`candidate ${method} ${path} returned ${response.status}: ${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rejectUnknownKeys(
  value: unknown,
  allowed: readonly string[],
  label: string,
  errors: string[],
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) errors.push(`${label} contains undeclared field ${key}`);
  }
}
