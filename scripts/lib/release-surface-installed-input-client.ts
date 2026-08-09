import { createHash, randomBytes } from "node:crypto";
import type { ReleaseSurfaceDriverRequest } from "./release-surface-driver-protocol";
import {
  RELEASE_SURFACE_MACOS_NATIVE_INPUT_HELPER_REQUEST_SCHEMA,
  RELEASE_SURFACE_MACOS_NATIVE_INPUT_HELPER_RESPONSE_SCHEMA,
  releaseSurfaceMacosNativeInputFileIdentity,
  runReleaseSurfaceMacosNativeInputHelper,
  validateReleaseSurfaceMacosNativeInputBinding,
  validateReleaseSurfaceMacosNativeInputRequestBinding,
  type ReleaseSurfaceMacosNativeInputBindingEvidence,
  type ReleaseSurfaceMacosNativeInputHelperRequest,
  type ReleaseSurfaceMacosNativeInputHelperResponse,
  type ReleaseSurfaceMacosNativeInputRect,
  type ReleaseSurfaceNativePickerKind,
} from "./release-surface-macos-native-input";
import type {
  ReleaseSurfaceCandidateAttestation,
  ReleaseSurfaceFileIdentity,
} from "./release-surface-candidate-attestation";
import { toReleaseSurfacePosixNativeBinding } from "./release-surface-posix-native-runtime";
import {
  acceptReleaseSurfaceWebDriverAlert,
  clearReleaseSurfaceWebDriverElement,
  clickReleaseSurfaceWebDriverElement,
  clickReleaseSurfaceWebDriverElementAtFraction,
  contextClickReleaseSurfaceWebDriverElement,
  dragReleaseSurfaceWebDriverElementToElement,
  closeReleaseSurfaceWebDriverWindow,
  executeReleaseSurfaceWebDriverScript,
  findReleaseSurfaceWebDriverElement,
  performReleaseSurfaceWebDriverKeyChord,
  releaseSurfaceWebDriverElementDisplayed,
  setReleaseSurfaceWebDriverElementValue,
  submitReleaseSurfaceWebDriverPrompt,
  switchReleaseSurfaceWebDriverWindow,
  switchReleaseSurfaceWebDriverWindowByTitle,
  waitForReleaseSurfaceWebDriverElement,
  waitForReleaseSurfaceWebDriverElementAbsent,
  type ReleaseSurfaceWebDriverElement,
} from "./release-surface-webdriver-client";
import {
  RELEASE_SURFACE_BOUNDED_OBSERVATION_SCRIPT,
  normalizeReleaseSurfaceObservationFields,
  validateReleaseSurfaceElementObservation,
  type ReleaseSurfaceElementObservation,
  type ReleaseSurfaceObservationField,
} from "./release-surface-bounded-observation";

const MAX_DEBUG_RESPONSE_BYTES = 256 * 1024;

class ReleaseSurfaceMacosRendererResolutionError extends Error {
  constructor() {
    super("candidate renderer did not resolve the bounded native-input target");
    this.name = "ReleaseSurfaceMacosRendererResolutionError";
  }
}

export type ReleaseSurfaceInstalledInputElement = ReleaseSurfaceWebDriverElement | {
  transport: "macos-native-input";
  selector: string;
  target: ReleaseSurfaceMacosNativeInputTarget;
};

export type ReleaseSurfaceInstalledInputSession = {
  transport: "native-webdriver";
  session: NonNullable<ReleaseSurfaceDriverRequest["nativeWebDriver"]>;
} | {
  transport: "macos-native-input";
  request: ReleaseSurfaceMacosInstalledInputContext;
  base: string;
  token: string;
  runHelper: typeof runReleaseSurfaceMacosNativeInputHelper;
  activeWindow: ReleaseSurfaceMacosNativeInputWindow;
};

type ReleaseSurfaceMacosInstalledInputContext = Pick<
  ReleaseSurfaceDriverRequest,
  "platform" | "runtime"
> & {
  platform: "macos-installed";
  macosNativeInput: NonNullable<ReleaseSurfaceDriverRequest["macosNativeInput"]>;
};

type ReleaseSurfaceMacosNativeInputWindow = {
  handle: "macos-native:app" | "macos-native:browser";
  surface: "app" | "browser";
  title: "shellX" | "ShellX Browser";
  windowNumber?: number;
};

type ReleaseSurfaceMacosNativeInputTarget = {
  windowNumber?: number;
  viewportWidth: number;
  viewportHeight: number;
  rect: ReleaseSurfaceMacosNativeInputRect;
};

type CandidateConnection = { base: string; token: string };

export function createReleaseSurfaceInstalledInputSession(
  request: ReleaseSurfaceDriverRequest,
  connection: CandidateConnection,
  options?: { runHelper?: typeof runReleaseSurfaceMacosNativeInputHelper },
): ReleaseSurfaceInstalledInputSession {
  if (request.nativeWebDriver && !request.macosNativeInput) {
    return { transport: "native-webdriver", session: request.nativeWebDriver };
  }
  if (request.platform !== "macos-installed" || !request.macosNativeInput || request.nativeWebDriver) {
    throw new Error("installed-input driver requires exactly one platform-native input binding");
  }
  const bindingErrors = validateReleaseSurfaceMacosNativeInputRequestBinding({
    binding: request.macosNativeInput,
    debugTokenPath: request.runtime.debugTokenPath,
  });
  if (bindingErrors.length > 0) {
    throw new Error(`macOS native-input request binding is invalid: ${bindingErrors.join("; ")}`);
  }
  const helper = releaseSurfaceMacosNativeInputFileIdentity(request.macosNativeInput.helperPath);
  if (JSON.stringify(helper) !== JSON.stringify(request.macosNativeInput.helper)) {
    throw new Error("macOS native-input helper bytes no longer match the exact request binding");
  }
  return {
    transport: "macos-native-input",
    request: {
      platform: "macos-installed",
      runtime: request.runtime,
      macosNativeInput: request.macosNativeInput,
    },
    base: connection.base.replace(/\/$/, ""),
    token: connection.token,
    runHelper: options?.runHelper ?? runReleaseSurfaceMacosNativeInputHelper,
    activeWindow: {
      handle: "macos-native:app",
      surface: "app",
      title: request.macosNativeInput.expectedWindowTitle,
      windowNumber: request.macosNativeInput.windowNumber,
    },
  };
}

export function createReleaseSurfaceMacosInstalledInputSession(input: {
  candidate: ReleaseSurfaceCandidateAttestation;
  helperPath: string;
  binding: ReleaseSurfaceMacosNativeInputBindingEvidence;
  bindingIdentity: ReleaseSurfaceFileIdentity;
  connection: CandidateConnection;
  runHelper?: typeof runReleaseSurfaceMacosNativeInputHelper;
}): ReleaseSurfaceInstalledInputSession {
  if (input.candidate.platform !== "macos-installed") {
    throw new Error("macOS installed-input session requires a macos-installed candidate");
  }
  const helper = releaseSurfaceMacosNativeInputFileIdentity(input.helperPath);
  const bindingErrors = validateReleaseSurfaceMacosNativeInputBinding({
    evidence: input.binding,
    candidate: input.candidate,
    helperPath: input.helperPath,
    helperIdentity: helper,
  });
  if (bindingErrors.length > 0) {
    throw new Error(`macOS installed-input binding is invalid: ${bindingErrors.join("; ")}`);
  }
  const request: ReleaseSurfaceMacosInstalledInputContext = {
    platform: "macos-installed",
    runtime: {
      processId: input.candidate.runtime.processId,
      instanceId: input.candidate.runtime.instanceId,
      debugBase: input.candidate.runtime.debugBase,
      debugTokenPath: input.candidate.runtime.debugTokenPath,
      mcpBase: input.candidate.runtime.mcpBase,
      mcpTokenPath: input.candidate.runtime.mcpTokenPath,
      executableSha256: input.candidate.process.executableSha256,
      installedPayloadPath: input.candidate.installedPayload.path,
      installedManifestSha256: input.candidate.installation.payloadManifestSha256,
      ...(input.candidate.posixNativeRuntime
        ? { posixNative: toReleaseSurfacePosixNativeBinding(input.candidate.posixNativeRuntime) }
        : {}),
    },
    macosNativeInput: {
      helperPath: input.helperPath,
      expectedWindowTitle: "shellX",
      windowNumber: input.binding.window.number,
      helper,
      evidence: input.bindingIdentity,
    },
  };
  const errors = validateReleaseSurfaceMacosNativeInputRequestBinding({
    binding: request.macosNativeInput,
    debugTokenPath: request.runtime.debugTokenPath,
  });
  if (errors.length > 0) {
    throw new Error(`macOS installed-input request binding is invalid: ${errors.join("; ")}`);
  }
  return {
    transport: "macos-native-input",
    request,
    base: input.connection.base.replace(/\/$/, ""),
    token: input.connection.token,
    runHelper: input.runHelper ?? runReleaseSurfaceMacosNativeInputHelper,
    activeWindow: {
      handle: "macos-native:app",
      surface: "app",
      title: "shellX",
      windowNumber: input.binding.window.number,
    },
  };
}

export async function findReleaseSurfaceInstalledInputElement(
  session: ReleaseSurfaceInstalledInputSession,
  selector: string,
): Promise<ReleaseSurfaceInstalledInputElement | null> {
  if (session.transport === "native-webdriver") {
    return findReleaseSurfaceWebDriverElement(session.session, selector);
  }
  const target = await resolveMacosTarget(session, selector);
  return target ? { transport: "macos-native-input", selector, target } : null;
}

export async function waitForReleaseSurfaceInstalledInputElement(
  session: ReleaseSurfaceInstalledInputSession,
  selector: string,
  options?: { timeoutMs?: number; pollMs?: number },
): Promise<ReleaseSurfaceInstalledInputElement> {
  if (session.transport === "native-webdriver") {
    return waitForReleaseSurfaceWebDriverElement(session.session, selector, options);
  }
  const deadline = Date.now() + (options?.timeoutMs ?? 20_000);
  const pollMs = options?.pollMs ?? 100;
  while (Date.now() < deadline) {
    try {
      const element = await findReleaseSurfaceInstalledInputElement(session, selector);
      if (element) return element;
    } catch (error) {
      if (!(error instanceof ReleaseSurfaceMacosRendererResolutionError)) throw error;
    }
    await delay(pollMs);
  }
  throw new Error(`macOS native-input target did not become visible before timeout: ${selector}`);
}

export async function waitForReleaseSurfaceInstalledInputElementAbsent(
  session: ReleaseSurfaceInstalledInputSession,
  selector: string,
  options?: { timeoutMs?: number; pollMs?: number },
): Promise<void> {
  if (session.transport === "native-webdriver") {
    return waitForReleaseSurfaceWebDriverElementAbsent(session.session, selector, options);
  }
  const deadline = Date.now() + (options?.timeoutMs ?? 5_000);
  const pollMs = options?.pollMs ?? 100;
  let rendererResolutionMissed = false;
  while (Date.now() < deadline) {
    try {
      if (!await findReleaseSurfaceInstalledInputElement(session, selector)) return;
      rendererResolutionMissed = false;
    } catch (error) {
      if (!(error instanceof ReleaseSurfaceMacosRendererResolutionError)) throw error;
      rendererResolutionMissed = true;
    }
    await delay(pollMs);
  }
  if (rendererResolutionMissed) {
    throw new Error(`macOS native-input target absence could not be proven after renderer resolution retries: ${selector}`);
  }
  throw new Error(`macOS native-input target remained present after cleanup: ${selector}`);
}

export async function releaseSurfaceInstalledInputElementDisplayed(
  session: ReleaseSurfaceInstalledInputSession,
  element: ReleaseSurfaceInstalledInputElement,
): Promise<boolean> {
  if (session.transport === "native-webdriver") {
    return releaseSurfaceWebDriverElementDisplayed(session.session, requireWebDriverElement(element));
  }
  return Boolean(await resolveMacosTarget(session, element.selector));
}

export async function observeReleaseSurfaceInstalledInputElement(
  session: ReleaseSurfaceInstalledInputSession,
  selector: string,
  fields: readonly ReleaseSurfaceObservationField[],
): Promise<ReleaseSurfaceElementObservation> {
  requireSelector(selector);
  const requested = normalizeReleaseSurfaceObservationFields(fields);
  if (session.transport === "native-webdriver") {
    const value = await executeReleaseSurfaceWebDriverScript(
      session.session,
      RELEASE_SURFACE_BOUNDED_OBSERVATION_SCRIPT,
      [selector, requested],
    );
    return validateReleaseSurfaceElementObservation(value, requested);
  }
  const result = await resolveMacosHighlightResult(session, selector, requested, true);
  return validateReleaseSurfaceElementObservation(result ? {
    present: true,
    visible: result.status === "resolved",
    observation: result.observation,
  } : {
    present: false,
    visible: false,
    observation: {},
  }, requested);
}

export async function clickReleaseSurfaceInstalledInputElement(
  session: ReleaseSurfaceInstalledInputSession,
  element: ReleaseSurfaceInstalledInputElement,
): Promise<void> {
  if (session.transport === "native-webdriver") {
    return clickReleaseSurfaceWebDriverElement(session.session, requireWebDriverElement(element));
  }
  await applyMacosAction(session, "click", await requireFreshMacosTarget(session, element));
}

export async function clickReleaseSurfaceInstalledInputElementAtFraction(
  session: ReleaseSurfaceInstalledInputSession,
  element: ReleaseSurfaceInstalledInputElement,
  xFraction: number,
  yFraction: number,
): Promise<void> {
  requireUnitFraction(xFraction, "xFraction");
  requireUnitFraction(yFraction, "yFraction");
  if (session.transport === "native-webdriver") {
    return clickReleaseSurfaceWebDriverElementAtFraction(
      session.session,
      requireWebDriverElement(element),
      xFraction,
      yFraction,
    );
  }
  const target = await requireFreshMacosTarget(session, element);
  const left = target.rect.left + Math.min(target.rect.width - 1, Math.max(1, target.rect.width * xFraction));
  const top = target.rect.top + Math.min(target.rect.height - 1, Math.max(1, target.rect.height * yFraction));
  await applyMacosAction(session, "click", {
    ...target,
    rect: { left, top, width: 1, height: 1 },
  });
}

export async function contextClickReleaseSurfaceInstalledInputElement(
  session: ReleaseSurfaceInstalledInputSession,
  element: ReleaseSurfaceInstalledInputElement,
): Promise<void> {
  if (session.transport === "native-webdriver") {
    return contextClickReleaseSurfaceWebDriverElement(session.session, requireWebDriverElement(element));
  }
  await applyMacosAction(session, "contextClick", await requireFreshMacosTarget(session, element));
}

export async function dragReleaseSurfaceInstalledInputElementToElement(
  session: ReleaseSurfaceInstalledInputSession,
  source: ReleaseSurfaceInstalledInputElement,
  target: ReleaseSurfaceInstalledInputElement,
): Promise<void> {
  if (source.selector === target.selector) throw new Error("installed-input drag source and target must be different elements");
  if (session.transport === "native-webdriver") {
    return dragReleaseSurfaceWebDriverElementToElement(
      session.session,
      requireWebDriverElement(source),
      requireWebDriverElement(target),
    );
  }
  // Resolve sequentially because the candidate exposes one bounded highlight
  // challenge at a time and each lookup must prove its own cleanup.
  const freshSource = await requireFreshMacosTarget(session, source);
  const freshTarget = await requireFreshMacosTarget(session, target);
  if (freshSource.windowNumber !== freshTarget.windowNumber
    || freshSource.viewportWidth !== freshTarget.viewportWidth
    || freshSource.viewportHeight !== freshTarget.viewportHeight) {
    throw new Error("macOS native-input drag source and target must share one stable candidate viewport");
  }
  const request: ReleaseSurfaceMacosNativeInputHelperRequest = {
    schema: RELEASE_SURFACE_MACOS_NATIVE_INPUT_HELPER_REQUEST_SCHEMA,
    action: "drag",
    candidate: {
      processId: session.request.runtime.processId,
      executablePath: session.request.runtime.installedPayloadPath,
      executableSha256: session.request.runtime.executableSha256,
      expectedWindowTitle: session.activeWindow.title,
    },
    target: freshSource,
    destinationTarget: freshTarget,
  };
  const response = session.runHelper(session.request.macosNativeInput!.helperPath, request);
  validateMacosBoundResponse(session, "drag", response, "applied", true);
  if (response.destinationMapping?.valid !== true
    || !Number.isFinite(response.destinationMapping.screenX)
    || !Number.isFinite(response.destinationMapping.screenY)
    || response.effect?.eventsPosted !== 8) {
    throw new Error("macOS native-input drag response did not prove its bounded source-to-target gesture");
  }
}

export async function setReleaseSurfaceInstalledInputElementValue(
  session: ReleaseSurfaceInstalledInputSession,
  element: ReleaseSurfaceInstalledInputElement,
  value: string,
): Promise<void> {
  if (session.transport === "native-webdriver") {
    return setReleaseSurfaceWebDriverElementValue(session.session, requireWebDriverElement(element), value);
  }
  await applyMacosAction(session, "typeText", await requireFreshMacosTarget(session, element), {
    text: value,
    replaceAll: false,
  });
}

export async function clearReleaseSurfaceInstalledInputElement(
  session: ReleaseSurfaceInstalledInputSession,
  element: ReleaseSurfaceInstalledInputElement,
): Promise<void> {
  if (session.transport === "native-webdriver") {
    return clearReleaseSurfaceWebDriverElement(session.session, requireWebDriverElement(element));
  }
  await applyMacosAction(session, "clear", await requireFreshMacosTarget(session, element));
}

export async function performReleaseSurfaceInstalledInputKeyChord(
  session: ReleaseSurfaceInstalledInputSession,
  keys: string[],
): Promise<void> {
  if (session.transport === "native-webdriver") {
    return performReleaseSurfaceWebDriverKeyChord(session.session, keys);
  }
  const body = await resolveMacosTarget(session, "body");
  if (!body) throw new Error("macOS native-input key chord could not bind the candidate renderer body");
  await applyMacosAction(session, "keyChord", body, { keys });
}

export async function selectReleaseSurfaceInstalledInputPickerPath(
  session: ReleaseSurfaceInstalledInputSession,
  input: {
    ownedRootPath: string;
    pickerPath: string;
    pickerKind: ReleaseSurfaceNativePickerKind;
  },
): Promise<void> {
  if (session.transport === "native-webdriver") {
    throw new Error(
      "native WebDriver is renderer-bound and cannot select an operating-system picker path; "
      + "this platform requires a separately attested candidate-bound native picker transport",
    );
  }
  const body = await resolveMacosTarget(session, "body");
  if (!body) throw new Error("macOS native-input picker action could not bind the candidate renderer body");
  const request: ReleaseSurfaceMacosNativeInputHelperRequest = {
    schema: RELEASE_SURFACE_MACOS_NATIVE_INPUT_HELPER_REQUEST_SCHEMA,
    action: "selectPickerPath",
    candidate: {
      processId: session.request.runtime.processId,
      executablePath: session.request.runtime.installedPayloadPath,
      executableSha256: session.request.runtime.executableSha256,
      expectedWindowTitle: session.activeWindow.title,
    },
    target: body,
    ...input,
  };
  const response = session.runHelper(session.request.macosNativeInput!.helperPath, request);
  validateMacosPickerResponse(session, response, input);
}

export async function executeReleaseSurfaceInstalledInputScript(
  session: ReleaseSurfaceInstalledInputSession,
  script: string,
  args: unknown[] = [],
): Promise<unknown> {
  if (session.transport === "native-webdriver") {
    return executeReleaseSurfaceWebDriverScript(session.session, script, args);
  }
  throw new Error("macOS native-input refuses arbitrary renderer script execution; use a bounded native action or an explicit safe oracle");
}

export async function switchReleaseSurfaceInstalledInputWindow(
  session: ReleaseSurfaceInstalledInputSession,
  handle: string,
): Promise<void> {
  if (session.transport === "native-webdriver") return switchReleaseSurfaceWebDriverWindow(session.session, handle);
  const target = macosWindowForHandle(session, handle);
  await bindMacosWindow(session, target);
}

export async function switchReleaseSurfaceInstalledInputWindowByTitle(
  session: ReleaseSurfaceInstalledInputSession,
  exactTitle: string,
): Promise<{ originalHandle: string; targetHandle: string }> {
  if (session.transport === "native-webdriver") {
    return switchReleaseSurfaceWebDriverWindowByTitle(session.session, exactTitle);
  }
  const original = { ...session.activeWindow };
  const target = macosWindowForTitle(session, exactTitle);
  await bindMacosWindow(session, target).catch((error) => {
    session.activeWindow = original;
    throw error;
  });
  return { originalHandle: original.handle, targetHandle: target.handle };
}

export async function closeReleaseSurfaceInstalledInputWindow(
  session: ReleaseSurfaceInstalledInputSession,
): Promise<void> {
  if (session.transport === "native-webdriver") return closeReleaseSurfaceWebDriverWindow(session.session);
  if (session.activeWindow.surface !== "browser") {
    throw new Error("macOS native-input refuses to close the attested main candidate window");
  }
  await performReleaseSurfaceInstalledInputKeyChord(session, ["meta", "w"]);
}

export async function acceptReleaseSurfaceInstalledInputAlert(
  session: ReleaseSurfaceInstalledInputSession,
  expectedText: string,
): Promise<void> {
  if (session.transport === "native-webdriver") {
    return acceptReleaseSurfaceWebDriverAlert(session.session, expectedText);
  }
  throw new Error("macOS native-input does not expose a bounded system-dialog confirmation channel");
}

export async function submitReleaseSurfaceInstalledInputPrompt(
  session: ReleaseSurfaceInstalledInputSession,
  expectedText: string,
  responseText: string,
): Promise<void> {
  if (session.transport === "native-webdriver") {
    return submitReleaseSurfaceWebDriverPrompt(session.session, expectedText, responseText);
  }
  throw new Error("macOS native-input does not expose a bounded system-dialog prompt channel");
}

async function bindMacosWindow(
  session: Extract<ReleaseSurfaceInstalledInputSession, { transport: "macos-native-input" }>,
  targetWindow: ReleaseSurfaceMacosNativeInputWindow,
): Promise<void> {
  const previous = session.activeWindow;
  session.activeWindow = { ...targetWindow };
  try {
    const target = await resolveMacosTarget(session, "body");
    if (!target) throw new Error(`macOS native-input window renderer did not resolve: ${targetWindow.title}`);
    const request: ReleaseSurfaceMacosNativeInputHelperRequest = {
      schema: RELEASE_SURFACE_MACOS_NATIVE_INPUT_HELPER_REQUEST_SCHEMA,
      action: "preflight",
      candidate: {
        processId: session.request.runtime.processId,
        executablePath: session.request.runtime.installedPayloadPath,
        executableSha256: session.request.runtime.executableSha256,
        expectedWindowTitle: targetWindow.title,
      },
      target,
    };
    const response = session.runHelper(session.request.macosNativeInput!.helperPath, request);
    validateMacosBoundResponse(session, "preflight", response, "ready", false);
  } catch (error) {
    session.activeWindow = previous;
    throw error;
  }
}

function macosWindowForTitle(
  session: Extract<ReleaseSurfaceInstalledInputSession, { transport: "macos-native-input" }>,
  title: string,
): ReleaseSurfaceMacosNativeInputWindow {
  if (title === "shellX") {
    return {
      handle: "macos-native:app",
      surface: "app",
      title: "shellX",
      windowNumber: session.request.macosNativeInput!.windowNumber,
    };
  }
  if (title === "ShellX Browser") {
    return { handle: "macos-native:browser", surface: "browser", title: "ShellX Browser" };
  }
  throw new Error(`macOS native-input title switching is not allowlisted for ${title}`);
}

function macosWindowForHandle(
  session: Extract<ReleaseSurfaceInstalledInputSession, { transport: "macos-native-input" }>,
  handle: string,
): ReleaseSurfaceMacosNativeInputWindow {
  if (handle === "macos-native:app") return macosWindowForTitle(session, "shellX");
  if (handle === "macos-native:browser") return macosWindowForTitle(session, "ShellX Browser");
  throw new Error("macOS native-input window handle is outside the exact two-window allowlist");
}

async function requireFreshMacosTarget(
  session: Extract<ReleaseSurfaceInstalledInputSession, { transport: "macos-native-input" }>,
  element: ReleaseSurfaceInstalledInputElement,
): Promise<ReleaseSurfaceMacosNativeInputTarget> {
  if (!("transport" in element) || element.transport !== "macos-native-input") {
    throw new Error("macOS native-input received an element from another transport");
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const target = await resolveMacosTarget(session, element.selector);
      if (!target) throw new Error(`macOS native-input target is no longer visible: ${element.selector}`);
      return target;
    } catch (error) {
      if (!(error instanceof ReleaseSurfaceMacosRendererResolutionError) || attempt === 2) throw error;
      await delay(100);
    }
  }
  throw new Error(`macOS native-input target could not be refreshed: ${element.selector}`);
}

async function resolveMacosTarget(
  session: Extract<ReleaseSurfaceInstalledInputSession, { transport: "macos-native-input" }>,
  selector: string,
): Promise<ReleaseSurfaceMacosNativeInputTarget | null> {
  const result = await resolveMacosHighlightResult(session, selector, []);
  if (!result) return null;
  return {
    ...(session.activeWindow.windowNumber ? { windowNumber: session.activeWindow.windowNumber } : {}),
    viewportWidth: Number(result.viewportWidth),
    viewportHeight: Number(result.viewportHeight),
    rect: result.visibleRect as ReleaseSurfaceMacosNativeInputRect,
  };
}

async function resolveMacosHighlightResult(
  session: Extract<ReleaseSurfaceInstalledInputSession, { transport: "macos-native-input" }>,
  selector: string,
  observe: readonly ReleaseSurfaceObservationField[],
  allowHiddenObservation = false,
): Promise<Record<string, unknown> | null> {
  requireSelector(selector);
  const id = `final-macos-action-${randomBytes(20).toString("hex")}`;
  let result: Record<string, unknown> | null = null;
  let primaryError: unknown = null;
  let cleared = false;
  try {
    await candidateJson(session, "POST", "/state/ui", {
      debugSurface: session.activeWindow.surface,
      source: "final-surface-macos-native-input-action",
      debugHighlights: [{ id, selector, label: id, color: "cyan", observe }],
    });
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const state = await candidateJson(session, "GET", "/state/ui") as Record<string, unknown>;
      const bySurface = isRecord(state.debugHighlightResultsBySurface)
        ? state.debugHighlightResultsBySurface as Record<string, unknown>
        : {};
      const surfaceRows = bySurface[session.activeWindow.surface];
      const rows = Array.isArray(surfaceRows)
        ? surfaceRows
        : Array.isArray(state.debugHighlightResults) ? state.debugHighlightResults : [];
      result = rows.filter(isRecord).find((row) => row.id === id) ?? null;
      if (result) break;
      await delay(25);
    }
    if (!result) throw new ReleaseSurfaceMacosRendererResolutionError();
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await candidateJson(session, "POST", "/state/ui", {
        debugSurface: session.activeWindow.surface,
        source: "final-surface-macos-native-input-action-cleanup",
        debugHighlights: [],
      });
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const state = await candidateJson(session, "GET", "/state/ui") as Record<string, unknown>;
        const bySurface = isRecord(state.debugHighlightResultsBySurface)
          ? state.debugHighlightResultsBySurface as Record<string, unknown>
          : {};
        const surfaceRows = bySurface[session.activeWindow.surface];
        const rows = Array.isArray(surfaceRows)
          ? surfaceRows
          : Array.isArray(state.debugHighlightResults) ? state.debugHighlightResults : [];
        if (!rows.filter(isRecord).some((row) => row.id === id)) {
          cleared = true;
          break;
        }
        await delay(25);
      }
    } catch (error) {
      if (!primaryError) primaryError = error;
    }
  }
  if (!cleared) throw new Error("macOS native-input target highlight did not clean up completely");
  if (primaryError) throw primaryError;
  if (!result || result.status === "missing") return null;
  if (result.status === "hidden") {
    const observationOnly = allowHiddenObservation
      && observe.length === 1
      && observe[0] === "href"
      && result.message === "matched element is outside the visible viewport"
      && validRect(result.rect)
      && positiveFinite(result.viewportWidth)
      && positiveFinite(result.viewportHeight)
      && isRecord(result.observation);
    if (observationOnly) return result;
    return null;
  }
  if (result.status !== "resolved"
    || !validRect(result.visibleRect)
    || !positiveFinite(result.viewportWidth)
    || !positiveFinite(result.viewportHeight)) {
    throw new Error(`macOS native-input target returned invalid renderer geometry: ${selector}`);
  }
  return result;
}

async function applyMacosAction(
  session: Extract<ReleaseSurfaceInstalledInputSession, { transport: "macos-native-input" }>,
  action: "click" | "contextClick" | "typeText" | "clear" | "keyChord",
  target: ReleaseSurfaceMacosNativeInputTarget,
  payload: { text?: string; replaceAll?: boolean; keys?: string[] } = {},
): Promise<void> {
  const request: ReleaseSurfaceMacosNativeInputHelperRequest = {
    schema: RELEASE_SURFACE_MACOS_NATIVE_INPUT_HELPER_REQUEST_SCHEMA,
    action,
    candidate: {
      processId: session.request.runtime.processId,
      executablePath: session.request.runtime.installedPayloadPath,
      executableSha256: session.request.runtime.executableSha256,
      expectedWindowTitle: session.activeWindow.title,
    },
    target,
    ...payload,
  };
  const response = session.runHelper(session.request.macosNativeInput!.helperPath, request);
  validateMacosBoundResponse(session, action, response, "applied", true);
}

function validateMacosPickerResponse(
  session: Extract<ReleaseSurfaceInstalledInputSession, { transport: "macos-native-input" }>,
  response: ReleaseSurfaceMacosNativeInputHelperResponse,
  input: {
    ownedRootPath: string;
    pickerPath: string;
    pickerKind: ReleaseSurfaceNativePickerKind;
  },
): void {
  validateMacosBoundResponse(session, "selectPickerPath", response, "applied", true);
  if (!response.picker
    || !(["AXSheet", "AXDialog", "AXWindow"] as string[]).includes(response.picker.role)
    || !/^[a-f0-9]{64}$/.test(response.picker.titleSha256)
    || response.picker.pathSha256 !== sha256(input.pickerPath)
    || response.picker.kind !== input.pickerKind
    || response.picker.rootVerified !== true
    || response.picker.dialogOwnedByCandidate !== true) {
    throw new Error("macOS native-input picker response did not prove its exact owned native-dialog path");
  }
}

function validateMacosBoundResponse(
  session: Extract<ReleaseSurfaceInstalledInputSession, { transport: "macos-native-input" }>,
  action: "preflight" | "click" | "contextClick" | "drag" | "typeText" | "clear" | "keyChord" | "selectPickerPath",
  response: ReleaseSurfaceMacosNativeInputHelperResponse,
  expectedStatus: "ready" | "applied",
  expectEffect: boolean,
): void {
  if (response.schema !== RELEASE_SURFACE_MACOS_NATIVE_INPUT_HELPER_RESPONSE_SCHEMA
    || response.action !== action || response.ok !== true || response.status !== expectedStatus) {
    throw new Error(`macOS native-input helper did not apply its exact ${action} contract`);
  }
  if (response.candidate?.processId !== session.request.runtime.processId
    || response.candidate?.executableSha256 !== session.request.runtime.executableSha256
    || response.candidate?.pathMatched !== true) {
    throw new Error("macOS native-input action response drifted from the exact candidate process");
  }
  if (response.permissions?.accessibilityTrusted !== true
    || response.permissions.eventPostingTrusted !== true
    || response.permissions.promptRequested !== false) {
    throw new Error("macOS native-input action lost its operator-granted permission binding");
  }
  if (!Number.isSafeInteger(response.window?.number) || Number(response.window?.number) <= 0
    || (session.activeWindow.windowNumber !== undefined && response.window?.number !== session.activeWindow.windowNumber)
    || response.window?.ownerProcessId !== session.request.runtime.processId
    || response.window?.titleSha256 !== sha256(session.activeWindow.title)
    || !(response.window?.webAreaSource === "ax-web-area"
      || response.window?.webAreaSource === "renderer-window-content")) {
    throw new Error("macOS native-input action response drifted from the bound candidate window");
  }
  session.activeWindow.windowNumber = response.window.number;
  if (response.mapping?.valid !== true
    || !Number.isFinite(response.mapping.screenX)
    || !Number.isFinite(response.mapping.screenY)
    || response.effect?.applicationActivated !== expectEffect
    || !Number.isSafeInteger(response.effect.eventsPosted)
    || (expectEffect ? response.effect.eventsPosted <= 0 : response.effect.eventsPosted !== 0)
    || response.effect.eventsPosted > 12) {
    throw new Error("macOS native-input action response did not prove one bounded native effect");
  }
}

async function candidateJson(
  session: Extract<ReleaseSurfaceInstalledInputSession, { transport: "macos-native-input" }>,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const headers = new Headers({ Authorization: `Bearer ${session.token}` });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`${session.base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(3_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`candidate ${method} ${path} returned ${response.status}`);
  if (Buffer.byteLength(text) > MAX_DEBUG_RESPONSE_BYTES) {
    throw new Error(`candidate ${method} ${path} response exceeded its JSON cap`);
  }
  return text ? JSON.parse(text) : {};
}

function requireWebDriverElement(element: ReleaseSurfaceInstalledInputElement): ReleaseSurfaceWebDriverElement {
  if ("transport" in element) throw new Error("native WebDriver received an element from another transport");
  return element;
}

function requireSelector(selector: string): void {
  if (!selector.trim() || selector.length > 4_096 || /[\r\n\0]/.test(selector)) {
    throw new Error("installed-input CSS selector must be non-empty, single-line, and at most 4096 characters");
  }
}

function requireUnitFraction(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`${label} must be a finite number strictly between zero and one`);
  }
}

function validRect(value: unknown): value is ReleaseSurfaceMacosNativeInputRect {
  if (!isRecord(value)) return false;
  return [value.left, value.top, value.width, value.height].every((part) => Number.isFinite(part))
    && Number(value.left) >= 0 && Number(value.top) >= 0
    && Number(value.width) > 0 && Number(value.height) > 0;
}

function positiveFinite(value: unknown): boolean {
  return Number.isFinite(value) && Number(value) > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
