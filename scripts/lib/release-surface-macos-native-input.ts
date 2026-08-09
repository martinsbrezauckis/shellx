import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, posix, relative, resolve, win32 } from "node:path";
import { lstatSync, openSync, closeSync, readSync } from "node:fs";
import type {
  ReleaseSurfaceCandidateAttestation,
  ReleaseSurfaceFileIdentity,
} from "./release-surface-candidate-attestation";

export const RELEASE_SURFACE_MACOS_NATIVE_INPUT_HELPER_REQUEST_SCHEMA =
  "shellx/release-surface-macos-native-input-helper-request@3";
export const RELEASE_SURFACE_MACOS_NATIVE_INPUT_HELPER_RESPONSE_SCHEMA =
  "shellx/release-surface-macos-native-input-helper-response@4";
export const RELEASE_SURFACE_MACOS_NATIVE_INPUT_BINDING_SCHEMA =
  "shellx/release-surface-macos-native-input-binding@2";

const MAX_HELPER_JSON_BYTES = 256 * 1024;
const DEFAULT_WINDOW_TITLE = "shellX";

export type ReleaseSurfaceMacosNativeInputAction =
  | "preflight"
  | "click"
  | "contextClick"
  | "drag"
  | "typeText"
  | "clear"
  | "keyChord"
  | "selectPickerPath";

export type ReleaseSurfaceNativePickerKind = "file" | "directory";

export interface ReleaseSurfaceMacosNativeInputRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ReleaseSurfaceMacosNativeInputHelperRequest {
  schema: typeof RELEASE_SURFACE_MACOS_NATIVE_INPUT_HELPER_REQUEST_SCHEMA;
  action: ReleaseSurfaceMacosNativeInputAction;
  candidate: {
    processId: number;
    executablePath: string;
    executableSha256: string;
    expectedWindowTitle: string;
  };
  target?: {
    windowNumber?: number;
    viewportWidth: number;
    viewportHeight: number;
    rect: ReleaseSurfaceMacosNativeInputRect;
  };
  destinationTarget?: {
    windowNumber?: number;
    viewportWidth: number;
    viewportHeight: number;
    rect: ReleaseSurfaceMacosNativeInputRect;
  };
  text?: string;
  replaceAll?: boolean;
  keys?: string[];
  ownedRootPath?: string;
  pickerPath?: string;
  pickerKind?: ReleaseSurfaceNativePickerKind;
}

export interface ReleaseSurfaceMacosNativeInputHelperResponse {
  schema: typeof RELEASE_SURFACE_MACOS_NATIVE_INPUT_HELPER_RESPONSE_SCHEMA;
  ok: boolean;
  action: ReleaseSurfaceMacosNativeInputAction;
  status: "ready" | "blocked" | "applied" | "failed";
  candidate?: {
    processId: number;
    executableSha256: string;
    pathMatched: boolean;
  };
  permissions?: {
    accessibilityTrusted: boolean;
    eventPostingTrusted: boolean;
    promptRequested: false;
  };
  window?: {
    number: number;
    ownerProcessId: number;
    titleSha256: string;
    bounds: ReleaseSurfaceMacosNativeInputRect;
    webAreaBounds: ReleaseSurfaceMacosNativeInputRect;
    webAreaSource: "ax-web-area" | "renderer-window-content";
  };
  mapping?: {
    valid: boolean;
    screenX: number;
    screenY: number;
  };
  destinationMapping?: {
    valid: boolean;
    screenX: number;
    screenY: number;
  };
  effect?: {
    applicationActivated: boolean;
    eventsPosted: number;
  };
  picker?: {
    role: "AXSheet" | "AXDialog" | "AXWindow";
    titleSha256: string;
    pathSha256: string;
    kind: ReleaseSurfaceNativePickerKind;
    rootVerified: true;
    dialogOwnedByCandidate: true;
  };
  error?: {
    code: string;
    message: string;
  };
}

export interface ReleaseSurfaceMacosNativeInputBindingEvidence {
  schema: typeof RELEASE_SURFACE_MACOS_NATIVE_INPUT_BINDING_SCHEMA;
  mode: "final-frozen-candidate";
  platform: "macos-installed";
  sourceCommit: string;
  version: string;
  createdAt: string;
  candidate: {
    processId: number;
    instanceId: string;
    executableSha256: string;
    installedPayloadSha256: string;
    distributionArtifactSha256: string;
    debugBase: string;
  };
  helper: ReleaseSurfaceFileIdentity;
  permissions: {
    accessibilityTrusted: true;
    eventPostingTrusted: true;
    promptRequested: false;
    operatorPrerequisite: "Accessibility";
  };
  window: {
    ownerProcessId: number;
    number: number;
    titleSha256: string;
    boundsSha256: string;
    webAreaBoundsSha256: string;
    webAreaSource: "ax-web-area" | "renderer-window-content";
  };
  challenge: {
    id: string;
    selectorSha256: string;
    rectSha256: string;
    candidateReportedResolved: true;
    helperMappedTarget: true;
    candidateReportedCleared: true;
    eventsPosted: 0;
  };
}

export interface ReleaseSurfaceMacosNativeInputRequestBinding {
  helperPath: string;
  expectedWindowTitle: "shellX";
  windowNumber: number;
  helper: ReleaseSurfaceFileIdentity;
  evidence: ReleaseSurfaceFileIdentity;
}

export class ReleaseSurfaceMacosAccessibilityBlockedError extends Error {
  readonly code = "MACOS_ACCESSIBILITY_PERMISSION_REQUIRED";
  readonly prerequisite = "Grant Accessibility to the exact release helper executable, then rerun the frozen-candidate proof.";

  constructor(message = "macOS native input is operator-blocked because Accessibility/event-posting trust is not granted") {
    super(message);
    this.name = "ReleaseSurfaceMacosAccessibilityBlockedError";
  }
}

type Fetch = typeof fetch;
type RunHelper = (
  helperPath: string,
  request: ReleaseSurfaceMacosNativeInputHelperRequest,
) => ReleaseSurfaceMacosNativeInputHelperResponse;

export async function proveReleaseSurfaceMacosNativeInputBinding(input: {
  candidate: ReleaseSurfaceCandidateAttestation;
  candidateToken: string;
  helperPath: string;
  fetchImpl?: Fetch;
  runHelper?: RunHelper;
  timeoutMs?: number;
  pollMs?: number;
  expectedWindowTitle?: string;
}): Promise<ReleaseSurfaceMacosNativeInputBindingEvidence> {
  const { candidate } = input;
  if (candidate.platform !== "macos-installed") {
    throw new Error("macOS native-input binding requires a macos-installed candidate attestation");
  }
  if (input.candidateToken.trim().length < 32) throw new Error("candidate Debug API token is invalid");
  const helperPath = resolveExactHelperPath(input.helperPath);
  assertSameDisposableFinalProfile(helperPath, candidate.runtime.debugTokenPath);
  const helper = releaseSurfaceMacosNativeInputFileIdentity(helperPath);
  const fetchImpl = input.fetchImpl ?? fetch;
  const runHelper = input.runHelper ?? runReleaseSurfaceMacosNativeInputHelper;
  const candidateBase = candidate.runtime.debugBase.replace(/\/$/, "");
  const expectedWindowTitle = input.expectedWindowTitle ?? DEFAULT_WINDOW_TITLE;
  if (!expectedWindowTitle.trim() || expectedWindowTitle.length > 256 || /[\r\n\0]/.test(expectedWindowTitle)) {
    throw new Error("expected macOS window title must be a bounded single-line string");
  }
  await assertExactCandidateHealth(fetchImpl, candidateBase, input.candidateToken, candidate);

  const challengeId = `final-macos-native-input-${randomBytes(24).toString("hex")}`;
  const challengeLabel = `shellx-macos-native-input-${randomBytes(16).toString("hex")}`;
  const selector = "body";
  let challenge: HighlightResult | null = null;
  let response: ReleaseSurfaceMacosNativeInputHelperResponse | null = null;
  let proofError: unknown = null;
  let cleanupError: unknown = null;
  let cleared = false;
  try {
    await candidateJson(fetchImpl, candidateBase, input.candidateToken, "POST", "/state/ui", {
      debugSurface: "app",
      source: "final-surface-macos-native-input-binding",
      debugHighlights: [{ id: challengeId, selector, label: challengeLabel, color: "cyan" }],
    });
    challenge = await waitForResolvedHighlight({
      fetchImpl,
      base: candidateBase,
      token: input.candidateToken,
      id: challengeId,
      timeoutMs: input.timeoutMs ?? 20_000,
      pollMs: input.pollMs ?? 100,
    });
    response = runHelper(helperPath, {
      schema: RELEASE_SURFACE_MACOS_NATIVE_INPUT_HELPER_REQUEST_SCHEMA,
      action: "preflight",
      candidate: {
        processId: candidate.runtime.processId,
        executablePath: candidate.process.executablePath,
        executableSha256: candidate.process.executableSha256,
        expectedWindowTitle,
      },
      target: {
        viewportWidth: challenge.viewportWidth,
        viewportHeight: challenge.viewportHeight,
        rect: challenge.visibleRect,
      },
    });
    if (response.permissions?.promptRequested !== false) {
      throw new Error("macOS native-input helper did not prove no-prompt permission preflight");
    }
    if (response.permissions.accessibilityTrusted !== true
      || response.permissions.eventPostingTrusted !== true
      || response.status === "blocked"
      || response.error?.code === "ACCESSIBILITY_PERMISSION_REQUIRED") {
      throw new ReleaseSurfaceMacosAccessibilityBlockedError();
    }
    validateReadyHelperResponse(response, candidate, expectedWindowTitle);
  } catch (error) {
    proofError = error;
  } finally {
    try {
      await candidateJson(fetchImpl, candidateBase, input.candidateToken, "POST", "/state/ui", {
        debugSurface: "app",
        source: "final-surface-macos-native-input-binding-cleanup",
        debugHighlights: [],
      });
      cleared = await waitForClearedHighlight({
        fetchImpl,
        base: candidateBase,
        token: input.candidateToken,
        id: challengeId,
        timeoutMs: Math.min(input.timeoutMs ?? 20_000, 5_000),
        pollMs: input.pollMs ?? 100,
      });
    } catch (error) {
      cleanupError = error;
    }
  }
  if (!cleared) {
    const suffix = cleanupError instanceof Error && cleanupError.message
      ? `: ${cleanupError.message}`
      : "";
    throw new Error(`macOS native-input candidate binding challenge did not clean up completely${suffix}`);
  }
  if (proofError) throw proofError;
  if (!challenge || !response?.window || !response.mapping) {
    throw new Error("macOS native-input binding omitted its exact challenge/window mapping");
  }
  return {
    schema: RELEASE_SURFACE_MACOS_NATIVE_INPUT_BINDING_SCHEMA,
    mode: "final-frozen-candidate",
    platform: "macos-installed",
    sourceCommit: candidate.sourceCommit,
    version: candidate.version,
    createdAt: new Date().toISOString(),
    candidate: {
      processId: candidate.runtime.processId,
      instanceId: candidate.runtime.instanceId,
      executableSha256: candidate.process.executableSha256,
      installedPayloadSha256: candidate.installedPayload.sha256,
      distributionArtifactSha256: candidate.distributionArtifact.sha256,
      debugBase: candidate.runtime.debugBase,
    },
    helper,
    permissions: {
      accessibilityTrusted: true,
      eventPostingTrusted: true,
      promptRequested: false,
      operatorPrerequisite: "Accessibility",
    },
    window: {
      ownerProcessId: response.window.ownerProcessId,
      number: response.window.number,
      titleSha256: response.window.titleSha256,
      boundsSha256: sha256Json(response.window.bounds),
      webAreaBoundsSha256: sha256Json(response.window.webAreaBounds),
      webAreaSource: response.window.webAreaSource,
    },
    challenge: {
      id: challengeId,
      selectorSha256: sha256(selector),
      rectSha256: sha256Json(challenge.visibleRect),
      candidateReportedResolved: true,
      helperMappedTarget: true,
      candidateReportedCleared: true,
      eventsPosted: 0,
    },
  };
}

export function validateReleaseSurfaceMacosNativeInputBinding(input: {
  evidence: ReleaseSurfaceMacosNativeInputBindingEvidence;
  candidate: ReleaseSurfaceCandidateAttestation;
  helperPath?: string;
  helperIdentity?: ReleaseSurfaceFileIdentity;
}): string[] {
  const { evidence, candidate } = input;
  const errors: string[] = [];
  if (evidence.schema !== RELEASE_SURFACE_MACOS_NATIVE_INPUT_BINDING_SCHEMA) {
    errors.push(`macOS native-input binding schema must be ${RELEASE_SURFACE_MACOS_NATIVE_INPUT_BINDING_SCHEMA}`);
  }
  if (evidence.mode !== "final-frozen-candidate") errors.push("macOS native-input binding mode must be final-frozen-candidate");
  if (evidence.platform !== "macos-installed" || candidate.platform !== "macos-installed") {
    errors.push("macOS native-input binding requires the macos-installed platform");
  }
  for (const [field, expected, actual] of [
    ["sourceCommit", candidate.sourceCommit, evidence.sourceCommit],
    ["version", candidate.version, evidence.version],
    ["processId", candidate.runtime.processId, evidence.candidate?.processId],
    ["instanceId", candidate.runtime.instanceId, evidence.candidate?.instanceId],
    ["executableSha256", candidate.process.executableSha256, evidence.candidate?.executableSha256],
    ["installedPayloadSha256", candidate.installedPayload.sha256, evidence.candidate?.installedPayloadSha256],
    ["distributionArtifactSha256", candidate.distributionArtifact.sha256, evidence.candidate?.distributionArtifactSha256],
    ["debugBase", candidate.runtime.debugBase, evidence.candidate?.debugBase],
  ] as const) {
    if (actual !== expected) errors.push(`macOS native-input binding ${field} does not match the exact candidate`);
  }
  if (!Number.isFinite(Date.parse(evidence.createdAt))) errors.push("macOS native-input binding createdAt must be a valid ISO timestamp");
  if (!input.helperPath && !input.helperIdentity) {
    errors.push("macOS native-input binding validation requires the live helper or its exact measured identity");
  }
  if (input.helperPath) {
    try {
      assertSameDisposableFinalProfile(resolveExactHelperPath(input.helperPath), candidate.runtime.debugTokenPath);
      const expectedHelper = releaseSurfaceMacosNativeInputFileIdentity(resolveExactHelperPath(input.helperPath));
      compareFileIdentity(errors, "helper", evidence.helper, expectedHelper);
      if (input.helperIdentity) compareFileIdentity(errors, "helper", input.helperIdentity, expectedHelper);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  } else if (input.helperIdentity) {
    compareFileIdentity(errors, "helper", evidence.helper, input.helperIdentity);
  }
  if (evidence.permissions?.accessibilityTrusted !== true
    || evidence.permissions?.eventPostingTrusted !== true
    || evidence.permissions?.promptRequested !== false
    || evidence.permissions?.operatorPrerequisite !== "Accessibility") {
    errors.push("macOS native-input binding must prove no-prompt Accessibility and event-posting trust");
  }
  if (evidence.window?.ownerProcessId !== candidate.runtime.processId) {
    errors.push("macOS native-input window owner does not match the exact candidate PID");
  }
  if (!Number.isSafeInteger(evidence.window?.number) || evidence.window.number <= 0) {
    errors.push("macOS native-input window number must be a positive integer");
  }
  if (!(evidence.window?.webAreaSource === "ax-web-area"
    || evidence.window?.webAreaSource === "renderer-window-content")) {
    errors.push("macOS native-input web area source is not an allowlisted exact-window mapping");
  }
  for (const [label, value] of [
    ["window title", evidence.window?.titleSha256],
    ["window bounds", evidence.window?.boundsSha256],
    ["web area bounds", evidence.window?.webAreaBoundsSha256],
    ["challenge selector", evidence.challenge?.selectorSha256],
    ["challenge rect", evidence.challenge?.rectSha256],
  ] as const) {
    if (!/^[a-f0-9]{64}$/.test(value ?? "")) errors.push(`macOS native-input ${label} hash is invalid`);
  }
  if (evidence.challenge?.candidateReportedResolved !== true
    || evidence.challenge?.helperMappedTarget !== true
    || evidence.challenge?.candidateReportedCleared !== true
    || evidence.challenge?.eventsPosted !== 0) {
    errors.push("macOS native-input binding challenge must map and clean up without posting input events");
  }
  return errors;
}

export function validateReleaseSurfaceMacosNativeInputRequestBinding(input: {
  binding: ReleaseSurfaceMacosNativeInputRequestBinding | undefined;
  debugTokenPath: string;
}): string[] {
  const errors: string[] = [];
  const binding = input.binding;
  if (!binding) return ["macOS native-input drivers require an exact helper binding receipt"];
  const allowed = new Set(["helperPath", "expectedWindowTitle", "windowNumber", "helper", "evidence"]);
  for (const key of Object.keys(binding)) {
    if (!allowed.has(key)) errors.push(`macOS native-input request binding contains undeclared field ${key}`);
  }
  if (binding.expectedWindowTitle !== DEFAULT_WINDOW_TITLE) {
    errors.push(`macOS native-input request window title must be ${DEFAULT_WINDOW_TITLE}`);
  }
  if (!Number.isSafeInteger(binding.windowNumber) || binding.windowNumber <= 0) {
    errors.push("macOS native-input request window number must be a positive integer");
  }
  try {
    const helperPath = resolveExactHelperPath(binding.helperPath);
    assertSameDisposableFinalProfile(helperPath, input.debugTokenPath);
    if (targetPathApi(helperPath).basename(helperPath) !== binding.helper?.basename) {
      errors.push("macOS native-input request helper basename does not match its exact path");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  for (const [label, identity] of [
    ["helper", binding.helper],
    ["binding evidence", binding.evidence],
  ] as const) {
    if (!identity?.basename?.trim()
      || !/^[a-f0-9]{64}$/.test(identity?.sha256 ?? "")
      || !Number.isSafeInteger(identity?.bytes)
      || identity.bytes <= 0) {
      errors.push(`macOS native-input request ${label} identity is invalid`);
    }
  }
  return errors;
}

export function runReleaseSurfaceMacosNativeInputHelper(
  helperPath: string,
  request: ReleaseSurfaceMacosNativeInputHelperRequest,
): ReleaseSurfaceMacosNativeInputHelperResponse {
  const path = resolveExactHelperPath(helperPath);
  validateHelperRequest(request);
  const input = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(input) > MAX_HELPER_JSON_BYTES) throw new Error("macOS native-input helper request exceeds its JSON cap");
  const run = spawnSync(path, [], {
    input,
    encoding: "utf8",
    maxBuffer: MAX_HELPER_JSON_BYTES,
    timeout: request.action === "preflight" ? 10_000 : 20_000,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  const stdout = run.stdout.trim();
  if (!stdout) throw new Error(`macOS native-input helper returned no JSON${run.error ? `: ${run.error.message}` : ""}`);
  let response: unknown;
  try {
    response = JSON.parse(stdout);
  } catch {
    throw new Error("macOS native-input helper returned invalid JSON");
  }
  if (!isRecord(response) || response.schema !== RELEASE_SURFACE_MACOS_NATIVE_INPUT_HELPER_RESPONSE_SCHEMA) {
    throw new Error("macOS native-input helper returned the wrong response schema");
  }
  const typed = response as unknown as ReleaseSurfaceMacosNativeInputHelperResponse;
  if (typed.action !== request.action) throw new Error("macOS native-input helper response action mismatch");
  if (run.status !== 0 && typed.status !== "blocked" && typed.status !== "failed") {
    throw new Error("macOS native-input helper failed without a typed blocked/failed response");
  }
  return typed;
}

export function releaseSurfaceMacosNativeInputFileIdentity(path: string): ReleaseSurfaceFileIdentity {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("macOS native-input helper must be a regular non-symlink file");
  if (stat.size <= 0) throw new Error("macOS native-input helper must be non-empty");
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
  } finally {
    closeSync(fd);
  }
  return { basename: basename(path), sha256: hash.digest("hex"), bytes: stat.size };
}

function validateReadyHelperResponse(
  response: ReleaseSurfaceMacosNativeInputHelperResponse,
  candidate: ReleaseSurfaceCandidateAttestation,
  expectedWindowTitle: string,
): void {
  if (response.schema !== RELEASE_SURFACE_MACOS_NATIVE_INPUT_HELPER_RESPONSE_SCHEMA
    || response.action !== "preflight" || response.ok !== true || response.status !== "ready") {
    const code = /^[A-Z0-9_]{1,64}$/.test(response.error?.code ?? "")
      ? `: ${response.error!.code}`
      : "";
    throw new Error(`macOS native-input helper did not return its exact ready preflight contract${code}`);
  }
  if (response.candidate?.processId !== candidate.runtime.processId
    || response.candidate?.executableSha256 !== candidate.process.executableSha256
    || response.candidate?.pathMatched !== true) {
    throw new Error("macOS native-input helper did not bind the exact candidate process image");
  }
  if (!response.window || response.window.ownerProcessId !== candidate.runtime.processId
    || !Number.isSafeInteger(response.window.number) || response.window.number <= 0
    || response.window.titleSha256 !== sha256(expectedWindowTitle)
    || !validRect(response.window.bounds) || !validRect(response.window.webAreaBounds)
    || !(response.window.webAreaSource === "ax-web-area"
      || response.window.webAreaSource === "renderer-window-content")) {
    throw new Error("macOS native-input helper did not bind the exact candidate window and AX web area");
  }
  if (response.mapping?.valid !== true
    || !Number.isFinite(response.mapping.screenX) || !Number.isFinite(response.mapping.screenY)
    || response.effect?.eventsPosted !== 0 || response.effect.applicationActivated !== false) {
    throw new Error("macOS native-input preflight did not map the target without posting or activating");
  }
}

interface HighlightResult {
  id: string;
  status: "resolved";
  visibleRect: ReleaseSurfaceMacosNativeInputRect;
  viewportWidth: number;
  viewportHeight: number;
}

async function waitForResolvedHighlight(input: {
  fetchImpl: Fetch;
  base: string;
  token: string;
  id: string;
  timeoutMs: number;
  pollMs: number;
}): Promise<HighlightResult> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    const state = await candidateJson(input.fetchImpl, input.base, input.token, "GET", "/state/ui") as {
      debugHighlightResults?: unknown[];
      debugHighlightResultsBySurface?: Record<string, unknown[]>;
    };
    const rows = state.debugHighlightResultsBySurface?.app ?? state.debugHighlightResults;
    if (!Array.isArray(rows)) {
      await delay(input.pollMs);
      continue;
    }
    const row = rows.filter(isRecord).find((value) => value.id === input.id);
    if (row?.status === "resolved" && validRect(row.visibleRect)
      && Number.isFinite(row.viewportWidth) && Number(row.viewportWidth) > 0
      && Number.isFinite(row.viewportHeight) && Number(row.viewportHeight) > 0) {
      return {
        id: input.id,
        status: "resolved",
        visibleRect: row.visibleRect as ReleaseSurfaceMacosNativeInputRect,
        viewportWidth: Number(row.viewportWidth),
        viewportHeight: Number(row.viewportHeight),
      };
    }
    await delay(input.pollMs);
  }
  throw new Error("macOS native-input binding challenge did not resolve in the exact candidate renderer");
}

async function waitForClearedHighlight(input: {
  fetchImpl: Fetch;
  base: string;
  token: string;
  id: string;
  timeoutMs: number;
  pollMs: number;
}): Promise<boolean> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    const state = await candidateJson(input.fetchImpl, input.base, input.token, "GET", "/state/ui") as {
      debugHighlightResults?: unknown[];
      debugHighlightResultsBySurface?: Record<string, unknown[]>;
    };
    const rows = state.debugHighlightResultsBySurface?.app ?? state.debugHighlightResults;
    if (!Array.isArray(rows)) {
      await delay(input.pollMs);
      continue;
    }
    if (!rows.filter(isRecord).some((row) => row.id === input.id)) return true;
    await delay(input.pollMs);
  }
  return false;
}

async function assertExactCandidateHealth(
  fetchImpl: Fetch,
  base: string,
  token: string,
  candidate: ReleaseSurfaceCandidateAttestation,
): Promise<void> {
  const health = await candidateJson(fetchImpl, base, token, "GET", "/health") as Record<string, unknown>;
  if (health.processId !== candidate.runtime.processId
    || health.instanceId !== candidate.runtime.instanceId
    || health.appVersion !== candidate.version
    || health.buildCommit !== candidate.sourceCommit) {
    throw new Error("macOS native-input Debug API health does not match the exact frozen candidate");
  }
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
  const text = await response.text();
  if (!response.ok) throw new Error(`candidate ${method} ${path} returned ${response.status}`);
  if (Buffer.byteLength(text) > MAX_HELPER_JSON_BYTES) throw new Error(`candidate ${method} ${path} response exceeded its JSON cap`);
  return text ? JSON.parse(text) : {};
}

function validateHelperRequest(request: ReleaseSurfaceMacosNativeInputHelperRequest): void {
  if (request.schema !== RELEASE_SURFACE_MACOS_NATIVE_INPUT_HELPER_REQUEST_SCHEMA) throw new Error("macOS native-input helper request schema is invalid");
  if (!(["preflight", "click", "contextClick", "drag", "typeText", "clear", "keyChord", "selectPickerPath"] as string[]).includes(request.action)) {
    throw new Error("macOS native-input helper action is invalid");
  }
  if (!Number.isSafeInteger(request.candidate?.processId) || request.candidate.processId <= 0
    || !isAbsolute(request.candidate?.executablePath ?? "")
    || !/^[a-f0-9]{64}$/.test(request.candidate?.executableSha256 ?? "")
    || typeof request.candidate?.expectedWindowTitle !== "string"
    || !request.candidate.expectedWindowTitle.trim()
    || request.candidate.expectedWindowTitle.length > 256
    || /[\r\n\0]/.test(request.candidate.expectedWindowTitle)) {
    throw new Error("macOS native-input helper candidate identity is invalid");
  }
  if (request.action !== "keyChord" && !request.target) throw new Error("macOS native-input pointer/text action requires a target mapping");
  if (request.target && (!validRect(request.target.rect)
    || !Number.isFinite(request.target.viewportWidth) || request.target.viewportWidth <= 0
    || !Number.isFinite(request.target.viewportHeight) || request.target.viewportHeight <= 0
    || request.target.rect.left < 0 || request.target.rect.top < 0
    || request.target.rect.left + request.target.rect.width > request.target.viewportWidth + 0.5
    || request.target.rect.top + request.target.rect.height > request.target.viewportHeight + 0.5
    || (request.target.windowNumber !== undefined
      && (!Number.isSafeInteger(request.target.windowNumber) || request.target.windowNumber <= 0)))) {
    throw new Error("macOS native-input target mapping is invalid");
  }
  if (request.action === "drag") {
    if (!request.destinationTarget
      || !validRect(request.destinationTarget.rect)
      || !Number.isFinite(request.destinationTarget.viewportWidth) || request.destinationTarget.viewportWidth <= 0
      || !Number.isFinite(request.destinationTarget.viewportHeight) || request.destinationTarget.viewportHeight <= 0
      || request.destinationTarget.rect.left < 0 || request.destinationTarget.rect.top < 0
      || request.destinationTarget.rect.left + request.destinationTarget.rect.width > request.destinationTarget.viewportWidth + 0.5
      || request.destinationTarget.rect.top + request.destinationTarget.rect.height > request.destinationTarget.viewportHeight + 0.5
      || (request.destinationTarget.windowNumber !== undefined
        && (!Number.isSafeInteger(request.destinationTarget.windowNumber) || request.destinationTarget.windowNumber <= 0))) {
      throw new Error("macOS native-input drag destination mapping is invalid");
    }
    if (request.target?.windowNumber !== request.destinationTarget.windowNumber
      || request.target?.viewportWidth !== request.destinationTarget.viewportWidth
      || request.target?.viewportHeight !== request.destinationTarget.viewportHeight) {
      throw new Error("macOS native-input drag must stay inside one stable candidate viewport");
    }
  } else if (request.destinationTarget !== undefined) {
    throw new Error("macOS native-input destination target requires the dedicated drag action");
  }
  if (request.action === "typeText" && (typeof request.text !== "string" || request.text.length > 64 * 1024 || request.text.includes("\0"))) {
    throw new Error("macOS native-input text payload is invalid");
  }
  if (request.action === "keyChord" && (!Array.isArray(request.keys) || request.keys.length === 0 || request.keys.length > 8)) {
    throw new Error("macOS native-input key chord is invalid");
  }
  if (request.keys?.some((key) => typeof key !== "string" || !key || key.length > 32 || /[\r\n\0]/.test(key))) {
    throw new Error("macOS native-input key chord contains an invalid key");
  }
  if (request.action === "selectPickerPath") {
    if (request.pickerKind !== "file" && request.pickerKind !== "directory") {
      throw new Error("macOS native-input picker kind is invalid");
    }
    for (const [label, value] of [
      ["owned root", request.ownedRootPath],
      ["picker path", request.pickerPath],
    ] as const) {
      if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value
        || value.length > 4_096 || /[\r\n\0]/.test(value)) {
        throw new Error(`macOS native-input ${label} is invalid`);
      }
    }
    const pickerRelative = relative(request.ownedRootPath!, request.pickerPath!);
    const pickerParts = pickerRelative.split("/");
    if (pickerParts.length !== 2
      || !/^release-native-picker-[a-f0-9]{16}$/.test(pickerParts[0] ?? "")
      || pickerParts[1] !== (request.pickerKind === "file" ? "attached.txt" : "selected-folder")) {
      throw new Error("macOS native-input picker path is outside the exact release-owned fixture shape");
    }
  } else if (request.ownedRootPath !== undefined || request.pickerPath !== undefined || request.pickerKind !== undefined) {
    throw new Error("macOS native-input picker fields require the dedicated picker action");
  }
}

function resolveExactHelperPath(value: string): string {
  const api = targetPathApi(value);
  if (!value || !api.isAbsolute(value)) throw new Error("macOS native-input helper path must be absolute");
  const path = api.resolve(value);
  if (path !== value) throw new Error("macOS native-input helper path must be normalized and exact");
  return path;
}

function assertSameDisposableFinalProfile(helperPath: string, tokenPath: string): void {
  const helperApi = targetPathApi(helperPath);
  const tokenApi = targetPathApi(tokenPath);
  if (helperApi !== tokenApi || !tokenApi.isAbsolute(tokenPath) || tokenApi.resolve(tokenPath) !== tokenPath) {
    throw new Error("macOS native-input candidate token path must be absolute and normalized");
  }
  const helperProfile = disposableFinalProfileAncestor(helperPath, helperApi);
  const tokenProfile = disposableFinalProfileAncestor(tokenPath, tokenApi);
  if (!helperProfile || !tokenProfile || helperProfile !== tokenProfile) {
    throw new Error("macOS native-input helper and candidate token must share the exact disposable final-run profile");
  }
}

function disposableFinalProfileAncestor(path: string, api = targetPathApi(path)): string | null {
  let current = api.dirname(path);
  while (true) {
    if (/^shellx-final-webdriver-[a-f0-9]{16,64}$/.test(api.basename(current))) return current;
    const parent = api.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function targetPathApi(value: string): typeof posix | typeof win32 {
  return value.startsWith("/") ? posix : win32;
}

function validRect(value: unknown): value is ReleaseSurfaceMacosNativeInputRect {
  if (!isRecord(value)) return false;
  return [value.left, value.top, value.width, value.height].every((part) => Number.isFinite(part))
    && Number(value.width) > 0 && Number(value.height) > 0;
}

function compareFileIdentity(
  errors: string[],
  label: string,
  actual: ReleaseSurfaceFileIdentity | undefined,
  expected: ReleaseSurfaceFileIdentity,
): void {
  if (actual?.basename !== expected.basename) errors.push(`macOS native-input ${label} basename does not match`);
  if (actual?.sha256 !== expected.sha256) errors.push(`macOS native-input ${label} hash does not match`);
  if (actual?.bytes !== expected.bytes) errors.push(`macOS native-input ${label} byte count does not match`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Json(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
