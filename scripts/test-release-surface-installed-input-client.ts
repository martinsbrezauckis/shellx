import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearReleaseSurfaceInstalledInputElement,
  clickReleaseSurfaceInstalledInputAccessibilityButton,
  clickReleaseSurfaceInstalledInputElement,
  clickReleaseSurfaceInstalledInputElementAtFraction,
  contextClickReleaseSurfaceInstalledInputElement,
  createReleaseSurfaceInstalledInputSession,
  dragReleaseSurfaceInstalledInputElementToElement,
  executeReleaseSurfaceInstalledInputScript,
  findReleaseSurfaceInstalledInputElement,
  focusReleaseSurfaceInstalledInputMainWindow,
  observeReleaseSurfaceInstalledInputElement,
  performReleaseSurfaceInstalledInputKeyChord,
  selectReleaseSurfaceInstalledInputPickerPath,
  setReleaseSurfaceInstalledInputElementValue,
  submitReleaseSurfaceInstalledInputPrompt,
  closeReleaseSurfaceInstalledInputWindow,
  switchReleaseSurfaceInstalledInputWindow,
  switchReleaseSurfaceInstalledInputWindowByTitle,
  waitForReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElementAbsent,
} from "./lib/release-surface-installed-input-client";
import {
  RELEASE_SURFACE_MACOS_NATIVE_INPUT_HELPER_RESPONSE_SCHEMA,
  releaseSurfaceMacosNativeInputFileIdentity,
  type ReleaseSurfaceMacosNativeInputHelperRequest,
  type ReleaseSurfaceMacosNativeInputHelperResponse,
} from "./lib/release-surface-macos-native-input";
import type { ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import { validateReleaseSurfaceElementObservation } from "./lib/release-surface-bounded-observation";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";
import { closeReleaseSurfaceWindowsNativeWindow } from "./lib/release-surface-windows-native-window";

const temp = mkdtempSync(join(tmpdir(), "shellx-installed-input-client-"));
const profile = join(temp, "shellx-final-webdriver-0123456789abcdef");
const tokenPath = join(profile, ".shellx", "debug.token");
const helperPath = join(profile, "shellx-release-macos-native-input");
const pickerDirectory = join(profile, "release-native-picker-0123456789abcdef");
const pickerPath = join(pickerDirectory, "attached.txt");
mkdirSync(join(profile, ".shellx"), { recursive: true });
mkdirSync(pickerDirectory);
writeFileSync(helperPath, "exact fixture helper bytes\n", { encoding: "utf8", mode: 0o700 });
writeFileSync(pickerPath, "exact picker fixture\n", "utf8");

try {
  const helper = releaseSurfaceMacosNativeInputFileIdentity(helperPath);
  const request = macosRequest(helperPath, tokenPath, helper);
  const api = fakeCandidateApi();
  const helperRequests: ReleaseSurfaceMacosNativeInputHelperRequest[] = [];
  const session = createReleaseSurfaceInstalledInputSession(request, {
    base: request.runtime.debugBase,
    token: "fixture-debug-token-that-is-long-enough",
  }, {
    runHelper: (path, action) => {
      assert.equal(path, helperPath);
      helperRequests.push(structuredClone(action));
      return appliedResponse(action, request);
    },
  });

  const element = await waitForReleaseSurfaceInstalledInputElement(session, "[data-debug-id='fixture']");
  const observation = await observeReleaseSurfaceInstalledInputElement(
    session,
    "[data-debug-id='fixture']",
    ["pressed", "focused"],
  );
  assert.deepEqual(observation, { present: true, visible: true, pressed: true, focused: false });
  const titleObservation = await observeReleaseSurfaceInstalledInputElement(
    session,
    "[data-debug-id='fixture']",
    ["title"],
  );
  assert.deepEqual(titleObservation, { present: true, visible: true, title: "Fixture title" });
  const scrollObservation = await observeReleaseSurfaceInstalledInputElement(
    session,
    "[data-debug-id='fixture']",
    ["scrollLeft", "scrollWidth", "clientWidth"],
  );
  assert.deepEqual(scrollObservation, {
    present: true,
    visible: true,
    scrollLeft: 240,
    scrollWidth: 1440,
    clientWidth: 720,
  });
  const mountedObservation = await observeReleaseSurfaceInstalledInputElement(
    session,
    "[data-debug-id='fixture']",
    ["mounted"],
  );
  assert.deepEqual(mountedObservation, { present: true, visible: true, mounted: true });
  const nonemptyObservation = await observeReleaseSurfaceInstalledInputElement(
    session,
    "[data-debug-id='fixture']",
    ["nonempty"],
  );
  assert.deepEqual(nonemptyObservation, { present: true, visible: true, nonempty: true });
  const offscreenLinkObservation = await observeReleaseSurfaceInstalledInputElement(
    session,
    ".offscreen-observation",
    ["href"],
  );
  assert.deepEqual(offscreenLinkObservation, {
    present: true,
    visible: false,
    href: "https://docs.theshellx.com/quick-start",
  });
  assert.equal(
    await findReleaseSurfaceInstalledInputElement(session, ".offscreen-observation"),
    null,
    "offscreen observation evidence must never become an actionable native-input target",
  );
  assert.deepEqual(
    await observeReleaseSurfaceInstalledInputElement(session, ".offscreen-wrong-message", ["href"]),
    { present: false, visible: false },
    "hidden observation evidence must fail closed unless it has the exact offscreen reason",
  );
  assert.throws(
    () => validateReleaseSurfaceElementObservation({
      present: true,
      visible: true,
      observation: { pressed: true, value: "undeclared" },
    }, ["pressed"]),
    /undeclared fields/,
  );
  assert.throws(
    () => validateReleaseSurfaceElementObservation({
      present: true,
      visible: true,
      observation: { value: "x".repeat(257) },
    }, ["value"]),
    /exceeded its declared value field/,
  );
  assert.throws(
    () => validateReleaseSurfaceElementObservation({
      present: true,
      visible: true,
      observation: { scrollLeft: -1 },
    }, ["scrollLeft"]),
    /exceeded its declared scrollLeft field/,
  );
  await clickReleaseSurfaceInstalledInputElement(session, element);
  await clickReleaseSurfaceInstalledInputElementAtFraction(session, element, 0.1, 0.2);
  await contextClickReleaseSurfaceInstalledInputElement(session, element);
  const dragTarget = await waitForReleaseSurfaceInstalledInputElement(session, "[data-debug-id='fixture-destination']");
  await dragReleaseSurfaceInstalledInputElementToElement(session, element, dragTarget);
  await clearReleaseSurfaceInstalledInputElement(session, element);
  await setReleaseSurfaceInstalledInputElementValue(session, element, "bounded fixture text");
  await performReleaseSurfaceInstalledInputKeyChord(session, ["meta", "k"]);
  await clickReleaseSurfaceInstalledInputAccessibilityButton(session, "Reset UI");
  await selectReleaseSurfaceInstalledInputPickerPath(session, {
    ownedRootPath: profile,
    pickerPath,
    pickerKind: "file",
  });
  await submitReleaseSurfaceInstalledInputPrompt(
    session,
    "Find what in the attached files?",
    "  SHELLX_RELEASE_FIND_CANARY_035  ",
  );
  assert.equal(await findReleaseSurfaceInstalledInputElement(session, ".absent"), null);
  await waitForReleaseSurfaceInstalledInputElementAbsent(session, ".absent", { timeoutMs: 100, pollMs: 1 });
  await waitForReleaseSurfaceInstalledInputElementAbsent(session, ".transient-absent", {
    timeoutMs: 5_000,
    pollMs: 1,
  });
  assert.equal(
    api.highlightRequestCount(".transient-absent"),
    2,
    "absence must retry a transient renderer resolution miss and require an explicit missing result",
  );
  await assert.rejects(
    executeReleaseSurfaceInstalledInputScript(session, "return window.__TAURI_INTERNALS__"),
    /refuses arbitrary renderer script execution/,
  );
  const switched = await switchReleaseSurfaceInstalledInputWindowByTitle(session, "ShellX Browser");
  assert.deepEqual(switched, {
    originalHandle: "macos-native:app",
    targetHandle: "macos-native:browser",
  });
  const browserElement = await waitForReleaseSurfaceInstalledInputElement(
    session,
    "[data-debug-id='browser-fixture']",
  );
  await clickReleaseSurfaceInstalledInputElement(session, browserElement);
  await closeReleaseSurfaceInstalledInputWindow(session);
  await switchReleaseSurfaceInstalledInputWindow(session, switched.originalHandle);
  await assert.rejects(
    switchReleaseSurfaceInstalledInputWindowByTitle(session, "Operator Secrets"),
    /not allowlisted/,
  );
  await assert.rejects(
    closeReleaseSurfaceInstalledInputWindow(session),
    /refuses to close the attested main candidate window/,
  );
  const transientAction = await waitForReleaseSurfaceInstalledInputElement(session, ".transient-action");
  await clickReleaseSurfaceInstalledInputElement(session, transientAction);
  assert.equal(
    api.highlightRequestCount(".transient-action"),
    3,
    "an action must retry a transient renderer resolution miss before posting native input",
  );

  assert.deepEqual(helperRequests.map((row) => row.action), [
    "click", "click", "contextClick", "drag", "clear", "typeText", "keyChord",
    "clickAccessibilityButton", "selectPickerPath", "submitPrompt", "preflight", "click", "keyChord", "preflight", "click",
  ]);
  assert.deepEqual(helperRequests[1]?.target?.rect, { left: 20, top: 26, width: 1, height: 1 });
  assert.deepEqual(helperRequests[3]?.destinationTarget?.rect, { left: 10, top: 20, width: 100, height: 30 });
  assert(helperRequests.slice(0, 7).every((row) => row.target?.windowNumber === 71));
  assert.equal(helperRequests[7]?.target, undefined);
  assert.equal(helperRequests[7]?.accessibilityLabel, "Reset UI");
  assert.equal(helperRequests[8]?.target?.windowNumber, 71);
  assert.equal(helperRequests[9]?.target, undefined);
  assert(helperRequests.slice(10, 13).every((row) => row.target?.windowNumber === undefined || row.target.windowNumber === 72));
  assert.equal(helperRequests[13]?.target?.windowNumber, 71);
  assert.equal(helperRequests[14]?.target?.windowNumber, 71);
  assert(helperRequests.every((row) => row.candidate.processId === request.runtime.processId));
  assert(helperRequests.every((row) => row.candidate.executableSha256 === request.runtime.executableSha256));
  assert.equal(helperRequests[5]?.text, "bounded fixture text");
  assert.equal(helperRequests[5]?.replaceAll, false);
  assert.deepEqual(helperRequests[6]?.keys, ["meta", "k"]);
  assert.equal(helperRequests[8]?.ownedRootPath, profile);
  assert.equal(helperRequests[8]?.pickerPath, pickerPath);
  assert.equal(helperRequests[8]?.pickerKind, "file");
  assert.equal(helperRequests[9]?.promptText, "Find what in the attached files?");
  assert.equal(helperRequests[9]?.promptResponseText, "  SHELLX_RELEASE_FIND_CANARY_035  ");
  assert.equal(helperRequests[10]?.candidate.expectedWindowTitle, "ShellX Browser");
  assert.equal(helperRequests[11]?.candidate.expectedWindowTitle, "ShellX Browser");
  assert.deepEqual(helperRequests[12]?.keys, ["meta", "w"]);
  assert.equal(helperRequests[13]?.candidate.expectedWindowTitle, "shellX");
  assert.equal(api.activeHighlight(), null, "every target lookup must clear its renderer highlight");
  assert(api.clearCount() >= 11, "success, absence, key-chord, and two-window target lookups must all clean up");

  const mixed = structuredClone(request);
  mixed.nativeWebDriver = {
    base: "http://127.0.0.1:31111",
    sessionId: "fixture-session-0001",
    evidence: { basename: "webdriver.json", sha256: "9".repeat(64), bytes: 10 },
  };
  assert.throws(
    () => createReleaseSurfaceInstalledInputSession(mixed, {
      base: mixed.runtime.debugBase,
      token: "fixture-debug-token-that-is-long-enough",
    }),
    /exactly one platform-native input binding/,
  );

  const webdriverOnly = structuredClone(request);
  delete webdriverOnly.macosNativeInput;
  delete webdriverOnly.runtime.posixNative;
  webdriverOnly.platform = "windows-installed";
  webdriverOnly.runtime.installedPayloadPath = "C:\\Program Files\\ShellX\\shellx.exe";
  webdriverOnly.runtime.windowsNative = {
    schema: "shellx/release-surface-windows-native-binding@1",
    process: {
      pid: webdriverOnly.runtime.processId,
      startId: "2026-07-28T17:59:00.000Z",
      imagePath: webdriverOnly.runtime.installedPayloadPath,
      imageSha256: webdriverOnly.runtime.executableSha256,
      imageBytes: 1024,
      imageFileId: `abcd1234:0x${"1".repeat(32)}`,
    },
    listener: { address: "127.0.0.1", port: 31_001, owningPid: webdriverOnly.runtime.processId },
  };
  const nativeCloseScript = readFileSync(
    join(import.meta.dirname, "close-release-surface-windows-window.ps1"),
    "utf8",
  );
  assert(nativeCloseScript.includes("Get-ExactCandidateProcess"));
  assert(nativeCloseScript.includes("EnumWindows"));
  assert(nativeCloseScript.includes("$matches.Count -ne 1"));
  assert(nativeCloseScript.includes("$wmClose = [uint32]0x0010"));
  const closeReceipt = closeReleaseSurfaceWindowsNativeWindow(
    webdriverOnly.runtime.windowsNative,
    "ShellX Browser",
    {
      scriptPath: "C:\\fixture\\close-release-surface-windows-window.ps1",
      run: ((_command: string, args: readonly string[]) => {
        assert(args.includes(String(webdriverOnly.runtime.processId)));
        assert(args.includes(webdriverOnly.runtime.windowsNative!.process.startId));
        assert(args.includes(webdriverOnly.runtime.installedPayloadPath));
        assert(args.includes("ShellX Browser"));
        return {
          status: 0,
          stdout: `${JSON.stringify({
            schema: "shellx/release-surface-windows-window-close@1",
            processId: webdriverOnly.runtime.processId,
            processStartId: webdriverOnly.runtime.windowsNative!.process.startId,
            title: "ShellX Browser",
            closed: true,
          })}\n`,
          stderr: "",
        };
      }) as never,
    },
  );
  assert.equal(closeReceipt.closed, true);
  webdriverOnly.nativeWebDriver = {
    base: "http://127.0.0.1:31111",
    sessionId: "fixture-session-0001",
    evidence: { basename: "webdriver.json", sha256: "9".repeat(64), bytes: 10 },
  };
  let windowsNativeCloseCount = 0;
  const webdriverSession = createReleaseSurfaceInstalledInputSession(webdriverOnly, {
    base: webdriverOnly.runtime.debugBase,
    token: "fixture-debug-token-that-is-long-enough",
  }, {
    closeWindowsNativeWindow: (binding, title) => {
      windowsNativeCloseCount += 1;
      assert.equal(binding.process.pid, webdriverOnly.runtime.processId);
      assert.equal(title, "ShellX Browser");
      return {
        schema: "shellx/release-surface-windows-window-close@1",
        processId: binding.process.pid,
        processStartId: binding.process.startId,
        title,
        closed: true,
      };
    },
  });
  await assert.rejects(
    clickReleaseSurfaceInstalledInputAccessibilityButton(webdriverSession, "Reset UI"),
    /available only to the attested macOS native-input helper/,
  );
  await clickReleaseSurfaceInstalledInputElementAtFraction(
    webdriverSession,
    { id: "fixture-backdrop", selector: "body" },
    0.1,
    0.2,
  );
  await contextClickReleaseSurfaceInstalledInputElement(
    webdriverSession,
    { id: "fixture-backdrop", selector: "body" },
  );
  await dragReleaseSurfaceInstalledInputElementToElement(
    webdriverSession,
    { id: "fixture-drag-source", selector: "#drag-source" },
    { id: "fixture-drag-target", selector: "#drag-target" },
  );
  await assert.rejects(
    selectReleaseSurfaceInstalledInputPickerPath(webdriverSession, {
      ownedRootPath: profile,
      pickerPath,
      pickerKind: "file",
    }),
    /requires a separately attested candidate-bound native picker transport/,
  );
  assert.deepEqual(api.pointerActions(), [{
    actions: [{
      type: "pointer",
      id: "shellx-release-pointer",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", duration: 0, origin: "viewport", x: 140, y: 110 },
        { type: "pointerDown", button: 0 },
        { type: "pointerUp", button: 0 },
      ],
    }],
  }, {
    actions: [{
      type: "pointer",
      id: "shellx-release-pointer",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", duration: 0, origin: "viewport", x: 300, y: 200 },
        { type: "pointerDown", button: 2 },
        { type: "pointerUp", button: 2 },
      ],
    }],
  }, {
    actions: [{
      type: "pointer",
      id: "shellx-release-pointer-drag",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", duration: 0, origin: { "element-6066-11e4-a52e-4f735466cecf": "fixture-drag-source" }, x: 0, y: 0 },
        { type: "pointerDown", button: 0 },
        { type: "pause", duration: 120 },
        { type: "pointerMove", duration: 320, origin: { "element-6066-11e4-a52e-4f735466cecf": "fixture-drag-target" }, x: 0, y: 0 },
        { type: "pause", duration: 80 },
        { type: "pointerUp", button: 0 },
      ],
    }],
  }]);
  await closeReleaseSurfaceInstalledInputWindow(webdriverSession);
  assert.equal(
    windowsNativeCloseCount,
    1,
    "ShellX Browser cleanup must request its candidate-owned native multi-WebView window close",
  );

  const linuxWebdriverOnly = structuredClone(webdriverOnly);
  linuxWebdriverOnly.platform = "linux-installed";
  delete linuxWebdriverOnly.runtime.windowsNative;
  const linuxWebdriverSession = createReleaseSurfaceInstalledInputSession(linuxWebdriverOnly, {
    base: linuxWebdriverOnly.runtime.debugBase,
    token: "fixture-debug-token-that-is-long-enough",
  }, {
    browserCloseTimeoutMs: 25,
  });
  await closeReleaseSurfaceInstalledInputWindow(linuxWebdriverSession);
  assert.equal(api.browserCloseRequestCount(), 1);
  assert.equal(api.webdriverWindowDeleteCount(), 1);
  assert.equal(
    await focusReleaseSurfaceInstalledInputMainWindow(linuxWebdriverSession),
    "main-shell",
    "a stale Browser renderer handle must be purged before the exact shellX main window is restored",
  );

  api.resetBrowser(false);
  const stalledLinuxSession = createReleaseSurfaceInstalledInputSession(linuxWebdriverOnly, {
    base: linuxWebdriverOnly.runtime.debugBase,
    token: "fixture-debug-token-that-is-long-enough",
  }, {
    browserCloseTimeoutMs: 25,
  });
  await assert.rejects(
    closeReleaseSurfaceInstalledInputWindow(stalledLinuxSession),
    /Native Browser close did not reconcile Debug API state/,
    "deleting only the stale Browser chrome handle must not certify native multi-WebView cleanup",
  );

  console.log("Release surface installed-input client tests passed");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

function macosRequest(
  helperPath: string,
  tokenPath: string,
  helper: { basename: string; sha256: string; bytes: number },
): ReleaseSurfaceDriverRequest {
  return {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId: "palette-action-installed",
    driverKind: "palette-action",
    platform: "macos-installed",
    sourceCommit: "a".repeat(40),
    version: "0.3.5",
    inventoryDigest: "b".repeat(64),
    artifact: { basename: "shellX.dmg", sha256: "c".repeat(64) },
    controller: {} as ReleaseSurfaceDriverRequest["controller"],
    runtime: {
      processId: 4321,
      instanceId: "fixture-instance-0001",
      debugBase: "http://127.0.0.1:31001",
      debugTokenPath: tokenPath,
      mcpBase: "http://127.0.0.1:31002",
      mcpTokenPath: join(profile, ".shellx", "mcp.token"),
      executableSha256: "d".repeat(64),
      installedPayloadPath: "/Applications/shellX.app/Contents/MacOS/shellx",
      installedManifestSha256: "e".repeat(64),
      posixNative: releaseSurfacePosixNativeBindingFixture({
        processId: 4321,
        port: 31_001,
        imagePath: "/Applications/shellX.app/Contents/MacOS/shellx",
        imageSha256: "d".repeat(64),
        platform: "macos",
      }),
    },
    macosNativeInput: {
      helperPath,
      expectedWindowTitle: "shellX",
      windowNumber: 71,
      helper,
      evidence: { basename: "macos-native-input-binding.json", sha256: "f".repeat(64), bytes: 2048 },
    },
    assignments: [],
  };
}

function fakeCandidateApi(): {
  activeHighlight: () => string | null;
  clearCount: () => number;
  highlightRequestCount: (selector: string) => number;
  pointerActions: () => unknown[];
  browserCloseRequestCount: () => number;
  webdriverWindowDeleteCount: () => number;
  resetBrowser: (closeRequestCompletes: boolean) => void;
} {
  let active: { id: string; selector: string; observe: string[]; surface: "app" | "browser" } | null = null;
  let clears = 0;
  const highlightRequests = new Map<string, number>();
  const pointerActions: unknown[] = [];
  let currentWindow = "browser-shell";
  let browserRendererHandleOpen = true;
  let browserNativeWindowOpen = true;
  let closeRequestCompletes = true;
  let browserCloseRequests = 0;
  let webdriverWindowDeletes = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1:31111/session/")) {
      if ((init?.method ?? "GET") === "GET" && url.endsWith("/title")) {
        return jsonResponse({ value: currentWindow === "main-shell" ? "shellX" : "ShellX Browser" });
      }
      if ((init?.method ?? "GET") === "GET" && url.endsWith("/window")) {
        return jsonResponse({ value: currentWindow });
      }
      if ((init?.method ?? "GET") === "GET" && url.endsWith("/window/handles")) {
        return jsonResponse({ value: browserRendererHandleOpen ? ["main-shell", "browser-shell"] : ["main-shell"] });
      }
      if (init?.method === "POST" && url.endsWith("/window")) {
        const handle = String(JSON.parse(String(init.body ?? "{}")).handle ?? "");
        if (handle !== "main-shell" && (handle !== "browser-shell" || !browserRendererHandleOpen)) {
          return jsonResponse({ value: { error: "no such window", message: "fixture window is absent" } }, 404);
        }
        currentWindow = handle;
        return jsonResponse({ value: null });
      }
      if (init?.method === "POST" && url.endsWith("/execute/sync")) {
        const script = String(JSON.parse(String(init.body ?? "{}")).script ?? "");
        if (currentWindow !== "browser-shell" || !script.includes('internals.invoke("plugin:window|close"')) {
          return jsonResponse({ value: { error: "unknown command", message: "fixture script is not allowlisted" } }, 400);
        }
        browserCloseRequests += 1;
        if (closeRequestCompletes) browserNativeWindowOpen = false;
        return jsonResponse({ value: true });
      }
      if (init?.method === "DELETE" && url.endsWith("/window")) {
        if (currentWindow !== "browser-shell" || !browserRendererHandleOpen) {
          return jsonResponse({ value: { error: "no such window", message: "fixture Browser window is absent" } }, 404);
        }
        webdriverWindowDeletes += 1;
        browserRendererHandleOpen = false;
        currentWindow = "main-shell";
        return jsonResponse({ value: ["main-shell"] });
      }
      if ((init?.method ?? "GET") === "GET" && url.endsWith("/element/fixture-backdrop/rect")) {
        return jsonResponse({ value: { x: 100, y: 50, width: 400, height: 300 } });
      }
      if (init?.method === "POST" && url.endsWith("/actions")) {
        const action = JSON.parse(String(init.body ?? "{}"));
        pointerActions.push(action);
        return jsonResponse({ value: null });
      }
      if (init?.method === "DELETE" && url.endsWith("/actions")) return jsonResponse({ value: null });
      return jsonResponse({ value: { error: "unknown command", message: "fixture path not handled" } }, 404);
    }
    if (url.endsWith("/browser/state") && (init?.method ?? "GET") === "GET") {
      return jsonResponse({
        windowOpen: browserNativeWindowOpen,
        engine: { mounted: browserNativeWindowOpen },
        enginePool: { engines: [{ mounted: browserNativeWindowOpen }] },
      });
    }
    if (!url.endsWith("/state/ui")) return new Response("not found", { status: 404 });
    if ((init?.method ?? "GET") === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        debugSurface?: string;
        debugHighlights?: Array<{ id?: string; selector?: string; observe?: string[] }>;
      };
      const highlight = body.debugHighlights?.[0];
      if (highlight?.id && highlight.selector) {
        highlightRequests.set(highlight.selector, (highlightRequests.get(highlight.selector) ?? 0) + 1);
        active = {
          id: highlight.id,
          selector: highlight.selector,
          observe: Array.isArray(highlight.observe) ? highlight.observe : [],
          surface: body.debugSurface === "browser" ? "browser" : "app",
        };
      }
      else {
        active = null;
        clears += 1;
      }
      return jsonResponse({ ok: true });
    }
    const offscreen = active?.selector.startsWith(".offscreen-") ?? false;
    const transientResolutionMiss = (
      active?.selector === ".transient-absent"
      && (highlightRequests.get(active.selector) ?? 0) === 1
    ) || (
      active?.selector === ".transient-action"
      && (highlightRequests.get(active.selector) ?? 0) === 2
    );
    const rows = active && !transientResolutionMiss ? [{
      id: active.id,
      selector: active.selector,
      status: active.selector === ".absent" || active.selector === ".transient-absent"
        ? "missing"
        : offscreen ? "hidden" : "resolved",
      ...(active.selector === ".absent" || active.selector === ".transient-absent" ? {} : {
        ...(offscreen ? {
          message: active.selector === ".offscreen-observation"
            ? "matched element is outside the visible viewport"
            : "matched element is not visible",
          rect: { left: 10, top: 900, width: 100, height: 30 },
        } : {
        visibleRect: { left: 10, top: 20, width: 100, height: 30 },
        }),
        viewportWidth: 1200,
        viewportHeight: 800,
        observation: Object.fromEntries(active.observe.map((field) => [
          field,
          field === "title" ? "Fixture title"
            : field === "href" ? "https://docs.theshellx.com/quick-start"
            : field === "scrollLeft" ? 240
              : field === "scrollWidth" ? 1440
                : field === "clientWidth" ? 720
              : field === "mounted" || field === "nonempty" ? true
                  : field === "pressed",
        ])),
      }),
    }] : [];
    return jsonResponse({
      debugHighlightResultsBySurface: {
        app: active?.surface === "app" ? rows : [],
        browser: active?.surface === "browser" ? rows : [],
      },
    });
  };
  process.once("beforeExit", () => { globalThis.fetch = originalFetch; });
  return {
    activeHighlight: () => active?.id ?? null,
    clearCount: () => clears,
    highlightRequestCount: (selector) => highlightRequests.get(selector) ?? 0,
    pointerActions: () => structuredClone(pointerActions),
    browserCloseRequestCount: () => browserCloseRequests,
    webdriverWindowDeleteCount: () => webdriverWindowDeletes,
    resetBrowser: (completes) => {
      currentWindow = "browser-shell";
      browserRendererHandleOpen = true;
      browserNativeWindowOpen = true;
      closeRequestCompletes = completes;
    },
  };
}

function appliedResponse(
  action: ReleaseSurfaceMacosNativeInputHelperRequest,
  request: ReleaseSurfaceDriverRequest,
): ReleaseSurfaceMacosNativeInputHelperResponse {
  const browser = action.candidate.expectedWindowTitle === "ShellX Browser";
  const preflight = action.action === "preflight";
  const picker = action.action === "selectPickerPath";
  const prompt = action.action === "submitPrompt";
  return {
    schema: RELEASE_SURFACE_MACOS_NATIVE_INPUT_HELPER_RESPONSE_SCHEMA,
    ok: true,
    action: action.action,
    status: preflight ? "ready" : "applied",
    candidate: {
      processId: request.runtime.processId,
      executableSha256: request.runtime.executableSha256,
      pathMatched: true,
    },
    permissions: {
      accessibilityTrusted: true,
      eventPostingTrusted: true,
      promptRequested: false,
    },
    ...(!prompt ? { window: {
      number: browser ? 72 : 71,
      ownerProcessId: request.runtime.processId,
      titleSha256: createHash("sha256").update(action.candidate.expectedWindowTitle).digest("hex"),
      bounds: { left: 0, top: 0, width: 1200, height: 800 },
      webAreaBounds: { left: 0, top: 0, width: 1200, height: 800 },
      webAreaSource: "ax-web-area",
    },
    mapping: { valid: true, screenX: 60, screenY: 35 } } : {}),
    ...(action.action === "drag" ? {
      destinationMapping: { valid: true, screenX: 90, screenY: 65 },
    } : {}),
    effect: {
      applicationActivated: !preflight,
      eventsPosted: preflight ? 0 : prompt || picker || action.action === "drag" ? 8 : action.action === "clear" ? 6 : action.action === "typeText" ? 4 : 2,
    },
    ...(picker ? {
      picker: {
        role: "AXSheet" as const,
        titleSha256: createHash("sha256").update("Open").digest("hex"),
        pathSha256: createHash("sha256").update(action.pickerPath!).digest("hex"),
        kind: action.pickerKind!,
        rootVerified: true as const,
        dialogOwnedByCandidate: true as const,
      },
    } : {}),
    ...(prompt ? {
      prompt: {
        role: "AXSheet" as const,
        promptTextSha256: createHash("sha256").update(action.promptText!).digest("hex"),
        responseTextSha256: createHash("sha256").update(action.promptResponseText!).digest("hex"),
        dialogOwnedByCandidate: true as const,
      },
    } : {}),
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}
