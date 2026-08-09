import {
  parseExactReleaseSurfaceWebDriverBase,
  type ReleaseSurfaceWebDriverSession,
} from "./release-surface-webdriver-binding";

const W3C_ELEMENT_ID = "element-6066-11e4-a52e-4f735466cecf";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_SCREENSHOT_RESPONSE_BYTES = 24 * 1024 * 1024;

export interface ReleaseSurfaceWebDriverElement {
  id: string;
  selector: string;
}

export async function releaseSurfaceWebDriverCurrentWindow(
  session: ReleaseSurfaceWebDriverSession,
): Promise<string> {
  const response = await webdriverRequest(session, "GET", "/window");
  return requireWindowHandle(response.value, "WebDriver current window response");
}

export async function releaseSurfaceWebDriverWindowHandles(
  session: ReleaseSurfaceWebDriverSession,
): Promise<string[]> {
  const response = await webdriverRequest(session, "GET", "/window/handles");
  if (!Array.isArray(response.value) || response.value.length === 0 || response.value.length > 32) {
    throw new Error("WebDriver window handles response must contain one to 32 handles");
  }
  const handles = response.value.map((value) => requireWindowHandle(value, "WebDriver window handle"));
  if (new Set(handles).size !== handles.length) throw new Error("WebDriver window handles must be unique");
  return handles;
}

export async function switchReleaseSurfaceWebDriverWindow(
  session: ReleaseSurfaceWebDriverSession,
  handle: string,
): Promise<void> {
  await webdriverRequest(session, "POST", "/window", {
    handle: requireWindowHandle(handle, "WebDriver target window handle"),
  });
}

export async function closeReleaseSurfaceWebDriverWindow(
  session: ReleaseSurfaceWebDriverSession,
): Promise<void> {
  await webdriverRequest(session, "DELETE", "/window");
}

export async function releaseSurfaceWebDriverWindowTitle(
  session: ReleaseSurfaceWebDriverSession,
): Promise<string> {
  const response = await webdriverRequest(session, "GET", "/title");
  if (typeof response.value !== "string" || response.value.length > 512 || response.value.includes("\0")) {
    throw new Error("WebDriver window title response must be a bounded string");
  }
  return response.value;
}

export async function setReleaseSurfaceWebDriverWindowRect(
  session: ReleaseSurfaceWebDriverSession,
  width: number,
  height: number,
): Promise<void> {
  if (!Number.isSafeInteger(width) || width < 800 || width > 7_680
    || !Number.isSafeInteger(height) || height < 600 || height > 4_320) {
    throw new Error("WebDriver window dimensions must be bounded positive integers");
  }
  await webdriverRequest(session, "POST", "/window/rect", { x: 0, y: 0, width, height });
}

export async function captureReleaseSurfaceWebDriverScreenshot(
  session: ReleaseSurfaceWebDriverSession,
): Promise<Buffer> {
  const response = await webdriverRequest(
    session,
    "GET",
    "/screenshot",
    undefined,
    false,
    MAX_SCREENSHOT_RESPONSE_BYTES,
  );
  if (typeof response.value !== "string" || response.value.length < 1_000) {
    throw new Error("WebDriver screenshot response must contain bounded base64 PNG bytes");
  }
  const png = Buffer.from(response.value, "base64");
  if (png.length < 10_000 || png.length > 16 * 1024 * 1024
    || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("WebDriver screenshot must be a bounded non-empty PNG");
  }
  return png;
}

export async function acceptReleaseSurfaceWebDriverAlert(
  session: ReleaseSurfaceWebDriverSession,
  expectedText: string,
): Promise<void> {
  if (!expectedText || expectedText.length > 4_096 || expectedText.includes("\0")) {
    throw new Error("WebDriver expected alert text must be non-empty, at most 4096 characters, and contain no NUL bytes");
  }
  const response = await webdriverRequest(session, "GET", "/alert/text");
  if (response.value !== expectedText) {
    throw new Error(`WebDriver alert text did not match the exact expected confirmation: ${JSON.stringify(response.value)}`);
  }
  await webdriverRequest(session, "POST", "/alert/accept", {});
}

export async function submitReleaseSurfaceWebDriverPrompt(
  session: ReleaseSurfaceWebDriverSession,
  expectedText: string,
  responseText: string,
): Promise<void> {
  if (!expectedText || expectedText.length > 4_096 || expectedText.includes("\0")) {
    throw new Error("WebDriver expected prompt text must be non-empty, at most 4096 characters, and contain no NUL bytes");
  }
  if (!responseText.trim() || responseText.length > 4_096 || responseText.includes("\0")) {
    throw new Error("WebDriver prompt response must be non-empty, at most 4096 characters, and contain no NUL bytes");
  }
  const response = await webdriverRequest(session, "GET", "/alert/text");
  if (response.value !== expectedText) {
    throw new Error(`WebDriver alert text did not match the exact expected prompt: ${JSON.stringify(response.value)}`);
  }
  await webdriverRequest(session, "POST", "/alert/text", { text: responseText });
  await webdriverRequest(session, "POST", "/alert/accept", {});
}

export async function switchReleaseSurfaceWebDriverWindowByTitle(
  session: ReleaseSurfaceWebDriverSession,
  exactTitle: string,
): Promise<{ originalHandle: string; targetHandle: string }> {
  if (!exactTitle.trim() || exactTitle.length > 512 || /[\r\n\0]/.test(exactTitle)) {
    throw new Error("WebDriver target window title must be non-empty, single-line, and bounded");
  }
  const originalHandle = await releaseSurfaceWebDriverCurrentWindow(session);
  const handles = await releaseSurfaceWebDriverWindowHandles(session);
  const observed: string[] = [];
  try {
    for (const handle of handles) {
      await switchReleaseSurfaceWebDriverWindow(session, handle);
      const title = await releaseSurfaceWebDriverWindowTitle(session);
      observed.push(title);
      if (title === exactTitle) return { originalHandle, targetHandle: handle };
    }
  } catch (error) {
    await switchReleaseSurfaceWebDriverWindow(session, originalHandle).catch(() => undefined);
    throw error;
  }
  await switchReleaseSurfaceWebDriverWindow(session, originalHandle);
  throw new Error(`WebDriver window title ${JSON.stringify(exactTitle)} was not found among ${JSON.stringify(observed)}`);
}

export async function executeReleaseSurfaceWebDriverScript(
  session: ReleaseSurfaceWebDriverSession,
  script: string,
  args: unknown[] = [],
): Promise<unknown> {
  if (!script.trim() || script.length > 128 * 1024 || script.includes("\0")) {
    throw new Error("WebDriver script must be non-empty, bounded, and contain no NUL bytes");
  }
  const encodedArgs = JSON.stringify(args);
  if (encodedArgs === undefined || Buffer.byteLength(encodedArgs) > 256 * 1024) {
    throw new Error("WebDriver script arguments exceed the bounded JSON payload");
  }
  const response = await webdriverRequest(session, "POST", "/execute/sync", { script, args });
  return response.value;
}

export async function waitForReleaseSurfaceWebDriverElement(
  session: ReleaseSurfaceWebDriverSession,
  selector: string,
  options?: { timeoutMs?: number; pollMs?: number },
): Promise<ReleaseSurfaceWebDriverElement> {
  const timeoutMs = options?.timeoutMs ?? 20_000;
  const pollMs = options?.pollMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const element = await findReleaseSurfaceWebDriverElement(session, selector);
    if (element && await releaseSurfaceWebDriverElementDisplayed(session, element)) return element;
    await delay(pollMs);
  }
  throw new Error(`WebDriver element did not become visible before timeout: ${selector}`);
}

export async function waitForReleaseSurfaceWebDriverElementAbsent(
  session: ReleaseSurfaceWebDriverSession,
  selector: string,
  options?: { timeoutMs?: number; pollMs?: number },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 5_000;
  const pollMs = options?.pollMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const element = await findReleaseSurfaceWebDriverElement(session, selector);
    if (!element) return;
    await delay(pollMs);
  }
  throw new Error(`WebDriver element remained present after cleanup: ${selector}`);
}

export async function findReleaseSurfaceWebDriverElement(
  session: ReleaseSurfaceWebDriverSession,
  selector: string,
): Promise<ReleaseSurfaceWebDriverElement | null> {
  requireSelector(selector);
  const response = await webdriverRequest(session, "POST", "/element", {
    using: "css selector",
    value: selector,
  }, true);
  if (response.missing) return null;
  const value = requireRecord(response.value, "WebDriver element response");
  const id = value[W3C_ELEMENT_ID] ?? value.ELEMENT;
  if (typeof id !== "string" || !/^[a-zA-Z0-9._:-]{1,512}$/.test(id)) {
    throw new Error("WebDriver element response did not contain a bounded W3C element id");
  }
  return { id, selector };
}

export async function clickReleaseSurfaceWebDriverElement(
  session: ReleaseSurfaceWebDriverSession,
  element: ReleaseSurfaceWebDriverElement,
): Promise<void> {
  requireElement(element);
  await webdriverRequest(session, "POST", `/element/${encodeURIComponent(element.id)}/click`, {});
}

export async function clickReleaseSurfaceWebDriverElementAtFraction(
  session: ReleaseSurfaceWebDriverSession,
  element: ReleaseSurfaceWebDriverElement,
  xFraction: number,
  yFraction: number,
): Promise<void> {
  await pointerClickReleaseSurfaceWebDriverElementAtFraction(session, element, xFraction, yFraction, 0);
}

export async function contextClickReleaseSurfaceWebDriverElement(
  session: ReleaseSurfaceWebDriverSession,
  element: ReleaseSurfaceWebDriverElement,
): Promise<void> {
  await pointerClickReleaseSurfaceWebDriverElementAtFraction(session, element, 0.5, 0.5, 2);
}

export async function dragReleaseSurfaceWebDriverElementToElement(
  session: ReleaseSurfaceWebDriverSession,
  source: ReleaseSurfaceWebDriverElement,
  target: ReleaseSurfaceWebDriverElement,
): Promise<void> {
  requireElement(source);
  requireElement(target);
  if (source.id === target.id) throw new Error("WebDriver drag source and target must be different elements");
  const elementOrigin = (element: ReleaseSurfaceWebDriverElement): Record<string, string> => ({
    [W3C_ELEMENT_ID]: element.id,
  });
  let actionError: unknown = null;
  try {
    await webdriverRequest(session, "POST", "/actions", {
      actions: [{
        type: "pointer",
        id: "shellx-release-pointer-drag",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", duration: 0, origin: elementOrigin(source), x: 0, y: 0 },
          { type: "pointerDown", button: 0 },
          { type: "pause", duration: 120 },
          { type: "pointerMove", duration: 320, origin: elementOrigin(target), x: 0, y: 0 },
          { type: "pause", duration: 80 },
          { type: "pointerUp", button: 0 },
        ],
      }],
    });
  } catch (error) {
    actionError = error;
  }
  try {
    await webdriverRequest(session, "DELETE", "/actions");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(actionError
      ? `${actionError instanceof Error ? actionError.message : String(actionError)}; drag pointer release failed: ${detail}`
      : `WebDriver drag pointer release failed: ${detail}`);
  }
  if (actionError) throw actionError;
}

async function pointerClickReleaseSurfaceWebDriverElementAtFraction(
  session: ReleaseSurfaceWebDriverSession,
  element: ReleaseSurfaceWebDriverElement,
  xFraction: number,
  yFraction: number,
  button: 0 | 2,
): Promise<void> {
  requireElement(element);
  requireUnitFraction(xFraction, "xFraction");
  requireUnitFraction(yFraction, "yFraction");
  const response = await webdriverRequest(
    session,
    "GET",
    `/element/${encodeURIComponent(element.id)}/rect`,
  );
  const rect = requireRecord(response.value, "WebDriver element rect");
  const x = requireFiniteNumber(rect.x, "WebDriver element rect.x");
  const y = requireFiniteNumber(rect.y, "WebDriver element rect.y");
  const width = requirePositiveNumber(rect.width, "WebDriver element rect.width");
  const height = requirePositiveNumber(rect.height, "WebDriver element rect.height");
  const pointX = Math.floor(x + Math.min(width - 1, Math.max(1, width * xFraction)));
  const pointY = Math.floor(y + Math.min(height - 1, Math.max(1, height * yFraction)));
  let actionError: unknown = null;
  try {
    await webdriverRequest(session, "POST", "/actions", {
      actions: [{
        type: "pointer",
        id: "shellx-release-pointer",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", duration: 0, origin: "viewport", x: pointX, y: pointY },
          { type: "pointerDown", button },
          { type: "pointerUp", button },
        ],
      }],
    });
  } catch (error) {
    actionError = error;
  }
  try {
    await webdriverRequest(session, "DELETE", "/actions");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(actionError
      ? `${actionError instanceof Error ? actionError.message : String(actionError)}; pointer release failed: ${detail}`
      : `WebDriver pointer release failed: ${detail}`);
  }
  if (actionError) throw actionError;
}

export async function setReleaseSurfaceWebDriverElementValue(
  session: ReleaseSurfaceWebDriverSession,
  element: ReleaseSurfaceWebDriverElement,
  value: string,
): Promise<void> {
  requireElement(element);
  if (value.length > 64 * 1024 || value.includes("\0")) {
    throw new Error("WebDriver element value must be at most 65536 characters and contain no NUL bytes");
  }
  await webdriverRequest(
    session,
    "POST",
    `/element/${encodeURIComponent(element.id)}/value`,
    { text: value, value: [...value] },
  );
}

export async function clearReleaseSurfaceWebDriverElement(
  session: ReleaseSurfaceWebDriverSession,
  element: ReleaseSurfaceWebDriverElement,
): Promise<void> {
  requireElement(element);
  await webdriverRequest(
    session,
    "POST",
    `/element/${encodeURIComponent(element.id)}/clear`,
    {},
  );
}

export async function releaseSurfaceWebDriverElementDisplayed(
  session: ReleaseSurfaceWebDriverSession,
  element: ReleaseSurfaceWebDriverElement,
): Promise<boolean> {
  requireElement(element);
  const response = await webdriverRequest(
    session,
    "GET",
    `/element/${encodeURIComponent(element.id)}/displayed`,
    undefined,
    true,
  );
  if (response.missing) return false;
  if (typeof response.value !== "boolean") throw new Error("WebDriver displayed response must be boolean");
  return response.value;
}

export async function performReleaseSurfaceWebDriverKeyChord(
  session: ReleaseSurfaceWebDriverSession,
  keys: string[],
): Promise<void> {
  if (keys.length === 0 || keys.length > 8 || keys.some((key) => [...key].length !== 1 || /[\r\n\0]/.test(key))) {
    throw new Error("WebDriver key chord must contain one to eight single-code-point key values");
  }
  let actionError: unknown = null;
  try {
    await webdriverRequest(session, "POST", "/actions", {
      actions: [{
        type: "key",
        id: "shellx-release-keyboard",
        actions: [
          ...keys.map((value) => ({ type: "keyDown", value })),
          ...[...keys].reverse().map((value) => ({ type: "keyUp", value })),
        ],
      }],
    });
  } catch (error) {
    actionError = error;
  }
  try {
    await webdriverRequest(session, "DELETE", "/actions");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(actionError
      ? `${actionError instanceof Error ? actionError.message : String(actionError)}; key release failed: ${detail}`
      : `WebDriver key release failed: ${detail}`);
  }
  if (actionError) throw actionError;
}

async function webdriverRequest(
  session: ReleaseSurfaceWebDriverSession,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  allowMissing = false,
  maxResponseBytes = MAX_RESPONSE_BYTES,
): Promise<{ value?: unknown; missing?: true }> {
  const base = parseExactReleaseSurfaceWebDriverBase(session.base);
  if (!base) throw new Error("WebDriver base must be an exact http://127.0.0.1:<port> origin");
  if (!/^[a-zA-Z0-9._:-]{8,256}$/.test(session.sessionId)) {
    throw new Error("WebDriver session id must be a bounded opaque identifier");
  }
  const response = await fetch(
    `${base.origin}/session/${encodeURIComponent(session.sessionId)}${path}`,
    {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(3_000),
    },
  );
  const text = await boundedResponseText(response, maxResponseBytes);
  let parsed: Record<string, unknown> = {};
  if (text) {
    try {
      parsed = requireRecord(JSON.parse(text), "WebDriver response");
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`WebDriver returned invalid JSON for ${method} ${path}`);
      throw error;
    }
  }
  if (!response.ok) {
    const value = typeof parsed.value === "object" && parsed.value !== null
      ? parsed.value as Record<string, unknown>
      : {};
    if (allowMissing && response.status === 404
      && (value.error === "no such element" || value.error === "stale element reference")) {
      return { missing: true };
    }
    const detail = typeof value.message === "string" ? value.message : text.slice(0, 1000);
    throw new Error(`WebDriver ${method} ${path} returned ${response.status}: ${detail}`);
  }
  return { value: parsed.value };
}

async function boundedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error(`WebDriver response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function requireSelector(selector: string): void {
  if (!selector.trim() || selector.length > 4_096 || /[\r\n\0]/.test(selector)) {
    throw new Error("WebDriver CSS selector must be non-empty, single-line, and at most 4096 characters");
  }
}

function requireElement(element: ReleaseSurfaceWebDriverElement): void {
  requireSelector(element.selector);
  if (!/^[a-zA-Z0-9._:-]{1,512}$/.test(element.id)) throw new Error("WebDriver element id is invalid");
}

function requireWindowHandle(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9._:-]{1,512}$/.test(value)) {
    throw new Error(`${label} must be a bounded opaque identifier`);
  }
  return value;
}

function requireUnitFraction(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`${label} must be a finite number strictly between zero and one`);
  }
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function requirePositiveNumber(value: unknown, label: string): number {
  const number = requireFiniteNumber(value, label);
  if (number <= 2) throw new Error(`${label} must exceed two CSS pixels`);
  return number;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
