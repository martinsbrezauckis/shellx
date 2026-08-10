import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { ReleaseSurfaceCandidateAttestation } from "./lib/release-surface-candidate-attestation";
import { validateReleaseSurfaceMacosNativeInputComposition } from "./lib/release-surface-receipt-composer";
import {
  RELEASE_SURFACE_MACOS_NATIVE_INPUT_HELPER_RESPONSE_SCHEMA,
  ReleaseSurfaceMacosAccessibilityBlockedError,
  proveReleaseSurfaceMacosNativeInputBinding,
  runReleaseSurfaceMacosNativeInputHelper,
  validateReleaseSurfaceMacosNativeInputBinding,
  type ReleaseSurfaceMacosNativeInputHelperRequest,
  type ReleaseSurfaceMacosNativeInputHelperResponse,
} from "./lib/release-surface-macos-native-input";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-macos-native-input-"));
const profileRoot = join(temp, "shellx-final-webdriver-0123456789abcdef");
mkdirSync(join(profileRoot, ".shellx"), { recursive: true });
const helperPath = join(profileRoot, "shellx-release-macos-native-input");
const candidate = candidateFixture(join(profileRoot, ".shellx", "debug.token"));
const token = "fixture-debug-token-that-is-long-enough";

try {
  writeFileSync(helperPath, "fixture helper bytes\n", { encoding: "utf8", mode: 0o700 });
  assert.throws(
    () => runReleaseSurfaceMacosNativeInputHelper(helperPath, {
      schema: "shellx/release-surface-macos-native-input-helper-request@3",
      action: "selectPickerPath",
      candidate: {
        processId: candidate.runtime.processId,
        executablePath: candidate.process.executablePath,
        executableSha256: candidate.process.executableSha256,
        expectedWindowTitle: "shellX",
      },
      target: {
        viewportWidth: 1200,
        viewportHeight: 800,
        rect: { left: 10, top: 20, width: 1100, height: 700 },
      },
      ownedRootPath: profileRoot,
      pickerPath: join(profileRoot, "operator-arbitrary.txt"),
      pickerKind: "file",
    }),
    /outside the exact release-owned fixture shape/,
  );

  const otherProfile = join(temp, "shellx-final-webdriver-fedcba9876543210");
  mkdirSync(otherProfile);
  const otherProfileHelper = join(otherProfile, "shellx-release-macos-native-input");
  writeFileSync(otherProfileHelper, "fixture helper bytes\n", { encoding: "utf8", mode: 0o700 });
  await assert.rejects(
    proveReleaseSurfaceMacosNativeInputBinding({
      candidate,
      candidateToken: token,
      helperPath: otherProfileHelper,
      fetchImpl: fakeCandidateApi(candidate).fetchImpl,
      timeoutMs: 50,
      pollMs: 1,
      runHelper: (_path, request) => readyResponse(request, candidate),
    }),
    /share the exact disposable final-run profile/,
  );

  const candidateApi = fakeCandidateApi(candidate);
  let helperCalls = 0;
  const evidence = await proveReleaseSurfaceMacosNativeInputBinding({
    candidate,
    candidateToken: token,
    helperPath,
    fetchImpl: candidateApi.fetchImpl,
    timeoutMs: 500,
    pollMs: 1,
    runHelper: (_path, request) => {
      helperCalls += 1;
      assert.equal(_path, helperPath);
      assert.deepEqual(request.candidate, {
        processId: candidate.runtime.processId,
        executablePath: candidate.process.executablePath,
        executableSha256: candidate.process.executableSha256,
        expectedWindowTitle: "shellX",
      });
      assert.equal(request.action, "preflight");
      assert.deepEqual(request.target, {
        viewportWidth: 1200,
        viewportHeight: 800,
        rect: { left: 10, top: 20, width: 1100, height: 700 },
      });
      return readyResponse(request, candidate);
    },
  });

  assert.equal(helperCalls, 1);
  assert.equal(candidateApi.healthCalls(), 1);
  assert.equal(candidateApi.activeChallenge(), null, "the binding challenge must be removed after proof");
  assert.deepEqual(validateReleaseSurfaceMacosNativeInputBinding({ evidence, candidate, helperPath }), []);
  assert.equal(evidence.candidate.processId, candidate.runtime.processId);
  assert.equal(evidence.candidate.instanceId, candidate.runtime.instanceId);
  assert.equal(evidence.candidate.executableSha256, candidate.process.executableSha256);
  assert.equal(evidence.candidate.installedPayloadSha256, candidate.installedPayload.sha256);
  assert.equal(evidence.candidate.distributionArtifactSha256, candidate.distributionArtifact.sha256);
  assert.equal(evidence.permissions.promptRequested, false);
  assert.equal(evidence.window.webAreaSource, "ax-web-area");
  assert.equal(evidence.challenge.eventsPosted, 0);
  assert.equal(evidence.challenge.candidateReportedCleared, true);
  const bindingIdentity = { basename: "macos-native-input-binding.json", sha256: "b".repeat(64), bytes: 2048 };
  const composedRequest = {
    helperPath,
    expectedWindowTitle: "shellX" as const,
    windowNumber: evidence.window.number,
    helper: evidence.helper,
    evidence: bindingIdentity,
  };
  assert.deepEqual(validateReleaseSurfaceMacosNativeInputComposition({
    request: composedRequest,
    runBinding: bindingIdentity,
    evidence,
    candidate,
  }), [], "final receipt composition must accept only the exact helper/window/run receipt binding");
  const driftedComposition = structuredClone(composedRequest);
  driftedComposition.evidence.sha256 = "c".repeat(64);
  driftedComposition.windowNumber += 1;
  const compositionErrors = validateReleaseSurfaceMacosNativeInputComposition({
    request: driftedComposition,
    runBinding: bindingIdentity,
    evidence,
    candidate,
  });
  assert(compositionErrors.some((error) => error.includes("driver-run binding")));
  assert(compositionErrors.some((error) => error.includes("window")));

  const serialized = JSON.stringify(evidence);
  assert(!serialized.includes(helperPath), "evidence must not disclose the helper path");
  assert(!serialized.includes(candidate.process.executablePath), "evidence must not disclose the candidate path");
  assert(!serialized.includes("shellx-macos-native-input-"), "evidence must not disclose the challenge label");
  assert(!serialized.includes('"screenX"'), "evidence must not disclose native screen coordinates");
  assert(!serialized.includes('"left"'), "evidence must hash rather than serialize candidate geometry");
  assert(!serialized.includes('"selector":"body"'), "evidence must hash rather than serialize the selector");

  const pidDrift = structuredClone(evidence);
  pidDrift.candidate.processId = 9999;
  assert(validateReleaseSurfaceMacosNativeInputBinding({ evidence: pidDrift, candidate, helperPath })
    .some((error) => error.includes("processId")));
  const artifactDrift = structuredClone(evidence);
  artifactDrift.candidate.distributionArtifactSha256 = "f".repeat(64);
  assert(validateReleaseSurfaceMacosNativeInputBinding({ evidence: artifactDrift, candidate, helperPath })
    .some((error) => error.includes("distributionArtifactSha256")));
  const mappingSourceDrift = structuredClone(evidence) as unknown as {
    window: { webAreaSource: string };
  };
  mappingSourceDrift.window.webAreaSource = "unbound-window-guess";
  assert(validateReleaseSurfaceMacosNativeInputBinding({
    evidence: mappingSourceDrift as typeof evidence,
    candidate,
    helperPath,
  }).some((error) => error.includes("web area source")));
  writeFileSync(helperPath, "tampered helper bytes\n", { encoding: "utf8", mode: 0o700 });
  assert(validateReleaseSurfaceMacosNativeInputBinding({ evidence, candidate, helperPath })
    .some((error) => error.includes("helper hash")), "helper byte drift must invalidate binding evidence");
  writeFileSync(helperPath, "fixture helper bytes\n", { encoding: "utf8", mode: 0o700 });

  const blockedApi = fakeCandidateApi(candidate);
  await assert.rejects(
    proveReleaseSurfaceMacosNativeInputBinding({
      candidate,
      candidateToken: token,
      helperPath,
      fetchImpl: blockedApi.fetchImpl,
      timeoutMs: 500,
      pollMs: 1,
      runHelper: (_path, request) => blockedResponse(request, candidate),
    }),
    (error: unknown) => error instanceof ReleaseSurfaceMacosAccessibilityBlockedError
      && error.code === "MACOS_ACCESSIBILITY_PERMISSION_REQUIRED"
      && error.prerequisite.includes("exact release helper"),
  );
  assert.equal(blockedApi.activeChallenge(), null, "permission-blocked proof must still clear its challenge");

  const mismatchApi = fakeCandidateApi(candidate);
  await assert.rejects(
    proveReleaseSurfaceMacosNativeInputBinding({
      candidate,
      candidateToken: token,
      helperPath,
      fetchImpl: mismatchApi.fetchImpl,
      timeoutMs: 500,
      pollMs: 1,
      runHelper: (_path, request) => ({
        ...readyResponse(request, candidate),
        window: { ...readyResponse(request, candidate).window!, ownerProcessId: 9999 },
      }),
    }),
    /exact candidate window/,
  );
  assert.equal(mismatchApi.activeChallenge(), null, "identity-mismatched proof must still clear its challenge");

  let unboundHelperCalls = 0;
  const wrongHealthApi = fakeCandidateApi(candidate, { processId: 9999 });
  await assert.rejects(
    proveReleaseSurfaceMacosNativeInputBinding({
      candidate,
      candidateToken: token,
      helperPath,
      fetchImpl: wrongHealthApi.fetchImpl,
      timeoutMs: 500,
      pollMs: 1,
      runHelper: (_path, request) => {
        unboundHelperCalls += 1;
        return readyResponse(request, candidate);
      },
    }),
    /health does not match/,
  );
  assert.equal(unboundHelperCalls, 0, "native helper must not run before exact Debug API health binds");

  const cleanupFailureApi = fakeCandidateApi(candidate, {}, true);
  await assert.rejects(
    proveReleaseSurfaceMacosNativeInputBinding({
      candidate,
      candidateToken: token,
      helperPath,
      fetchImpl: cleanupFailureApi.fetchImpl,
      timeoutMs: 25,
      pollMs: 1,
      runHelper: (_path, request) => blockedResponse(request, candidate),
    }),
    /did not clean up completely/,
    "an earlier permission block must not hide missing cleanup proof",
  );

  assertStaticNativeHelperContract();
  console.log("Release surface macOS native-input foundation tests passed");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

function readyResponse(
  request: ReleaseSurfaceMacosNativeInputHelperRequest,
  exactCandidate: ReleaseSurfaceCandidateAttestation,
): ReleaseSurfaceMacosNativeInputHelperResponse {
  return {
    schema: RELEASE_SURFACE_MACOS_NATIVE_INPUT_HELPER_RESPONSE_SCHEMA,
    ok: true,
    action: request.action,
    status: "ready",
    candidate: {
      processId: exactCandidate.runtime.processId,
      executableSha256: exactCandidate.process.executableSha256,
      pathMatched: true,
    },
    permissions: {
      accessibilityTrusted: true,
      eventPostingTrusted: true,
      promptRequested: false,
    },
    window: {
      number: 71,
      ownerProcessId: exactCandidate.runtime.processId,
      titleSha256: sha256("shellX"),
      bounds: { left: 100, top: 50, width: 1200, height: 800 },
      webAreaBounds: { left: 100, top: 50, width: 1200, height: 800 },
      webAreaSource: "ax-web-area",
    },
    mapping: { valid: true, screenX: 660, screenY: 420 },
    effect: { applicationActivated: false, eventsPosted: 0 },
  };
}

function blockedResponse(
  request: ReleaseSurfaceMacosNativeInputHelperRequest,
  exactCandidate: ReleaseSurfaceCandidateAttestation,
): ReleaseSurfaceMacosNativeInputHelperResponse {
  return {
    schema: RELEASE_SURFACE_MACOS_NATIVE_INPUT_HELPER_RESPONSE_SCHEMA,
    ok: false,
    action: request.action,
    status: "blocked",
    candidate: {
      processId: exactCandidate.runtime.processId,
      executableSha256: exactCandidate.process.executableSha256,
      pathMatched: true,
    },
    permissions: {
      accessibilityTrusted: false,
      eventPostingTrusted: false,
      promptRequested: false,
    },
    effect: { applicationActivated: false, eventsPosted: 0 },
    error: {
      code: "ACCESSIBILITY_PERMISSION_REQUIRED",
      message: "operator prerequisite is absent",
    },
  };
}

function fakeCandidateApi(
  exactCandidate: ReleaseSurfaceCandidateAttestation,
  healthOverride: Record<string, unknown> = {},
  failCleanup = false,
): {
  fetchImpl: typeof fetch;
  activeChallenge: () => { id: string; label: string } | null;
  healthCalls: () => number;
} {
  let challenge: { id: string; label: string } | null = null;
  let healthCallCount = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === `${exactCandidate.runtime.debugBase}/health` && method === "GET") {
      healthCallCount += 1;
      return jsonResponse({
        processId: exactCandidate.runtime.processId,
        instanceId: exactCandidate.runtime.instanceId,
        appVersion: exactCandidate.version,
        buildCommit: exactCandidate.sourceCommit,
        ...healthOverride,
      });
    }
    if (url === `${exactCandidate.runtime.debugBase}/state/ui` && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        debugHighlights?: Array<{ id?: string; label?: string }>;
      };
      const row = body.debugHighlights?.[0];
      if (row?.id && row.label) {
        challenge = { id: row.id, label: row.label };
      } else {
        if (!failCleanup) challenge = null;
      }
      return jsonResponse({ ok: true });
    }
    if (url === `${exactCandidate.runtime.debugBase}/state/ui` && method === "GET") {
      const rows = challenge ? [{
        id: challenge.id,
        status: "resolved",
        visibleRect: { left: 10, top: 20, width: 1100, height: 700 },
        viewportWidth: 1200,
        viewportHeight: 800,
      }] : [];
      return jsonResponse({ debugHighlightResultsBySurface: { app: rows } });
    }
    return new Response("not found", { status: 404 });
  };
  return {
    fetchImpl,
    activeChallenge: () => challenge,
    healthCalls: () => healthCallCount,
  };
}

function assertStaticNativeHelperContract(): void {
  const swiftPath = resolve(root, "scripts/native/macos-release-input.swift");
  const swift = readFileSync(swiftPath, "utf8");
  const build = readFileSync(resolve(root, "scripts/build-release-surface-macos-native-input.ts"), "utf8");
  const proof = readFileSync(resolve(root, "scripts/prove-release-surface-macos-native-input-binding.ts"), "utf8");
  const packageJson = readFileSync(resolve(root, "package.json"), "utf8");
  const tauriLib = readFileSync(resolve(root, "src-tauri/src/lib.rs"), "utf8");

  for (const required of [
    "AXIsProcessTrusted()",
    "CGPreflightPostEventAccess()",
    "CGEvent(",
    '"AXWebArea"',
    '"renderer-window-content"',
    "RENDERER_VIEWPORT_MISMATCH",
    "PROCESS_HASH_MISMATCH",
    "WINDOW_IDENTITY_MISMATCH",
    "eventsPosted: 0",
    'case "selectPickerPath"',
    'case "drag"',
    "postMouseDrag",
    ".leftMouseDragged",
    "validateOwnedPickerPath",
    "PICKER_PATH_OUTSIDE_ROOT",
    "PICKER_PATH_OUTSIDE_FIXTURE",
    "shellx-final-profile.json",
    "markerSize <= 16_384",
    "candidate picker unexpectedly contains renderer web content",
    "dialogOwnedByCandidate: true",
  ]) {
    assert(swift.includes(required), `native helper must contain ${required}`);
  }
  for (const forbidden of [
    "AXIsProcessTrustedWithOptions",
    "kAXTrustedCheckOptionPrompt",
    "CGRequestPostEventAccess",
    "kCGWindowName",
    "osascript",
    "cliclick",
    "System Events",
  ]) {
    assert(!swift.includes(forbidden), `native helper must not use ${forbidden}`);
  }
  assert(
    swift.indexOf("let boundProcess = try bindProcess") < swift.indexOf("let accessibilityTrusted = AXIsProcessTrusted()"),
    "the helper must bind exact process bytes before checking or applying native input",
  );
  assert(
    swift.indexOf("guard accessibilityTrusted && eventPostingTrusted") < swift.indexOf("let window = try bindWindow"),
    "the helper must fail permission preflight before walking Accessibility UI",
  );
  assert(
    swift.includes("as? NSDictionary") && swift.includes("boundsObject as CFDictionary"),
    "the helper must bridge CoreGraphics window bounds through a checked Foundation dictionary",
  );
  assert(
    swift.includes("func axAttribute(_ element: AXUIElement, _ name: String)")
      && swift.includes("AXUIElementCopyAttributeValue(element, name as CFString, &value)"),
    "the helper must bridge Swift 6 Accessibility attribute constants explicitly",
  );
  assert(
    swift.includes("CFGetTypeID(value) == AXValueGetTypeID()")
      && swift.includes("CFGetTypeID(value) == AXUIElementGetTypeID()")
      && swift.includes("axValueAttribute(element, kAXPositionAttribute)")
      && swift.includes("axElementAttribute(applicationElement, kAXFocusedWindowAttribute)"),
    "the helper must check CoreFoundation type identities before typed Accessibility access",
  );
  assert(
    swift.includes("boundProcess.application.activate()")
      && !swift.includes("activateIgnoringOtherApps"),
    "the helper must use the current macOS activation contract without deprecated ignored options",
  );
  assert(
    swift.includes("func postMouseClick(at point: CGPoint)")
      && swift.includes("down.post(tap: .cghidEventTap)")
      && swift.includes("up.post(tap: .cghidEventTap)")
      && swift.includes("postMouseClick(at: point)")
      && swift.includes("NSWorkspace.shared.frontmostApplication?.processIdentifier == request.candidate.processId"),
    "bounded renderer clicks must post the mapped mouse pair only after the exact candidate is frontmost",
  );
  assert.match(
    swift,
    /func postMouseClick\(at point: CGPoint\)[\s\S]*?down\.post\(tap: \.cghidEventTap\)\s+Thread\.sleep\(forTimeInterval: 0\.025\)\s+up\.post\(tap: \.cghidEventTap\)/,
    "bounded renderer clicks must retain a short press dwell so WKWebView receives the complete gesture",
  );
  assert.match(
    swift,
    /func postContextClick\(at point: CGPoint\)[\s\S]*?down\.post\(tap: \.cghidEventTap\)\s+Thread\.sleep\(forTimeInterval: 0\.025\)\s+up\.post\(tap: \.cghidEventTap\)/,
    "bounded renderer context clicks must retain the same short press dwell",
  );
  assert(
    !swift.includes("postAccessibilityPress"),
    "renderer clicks must not accept a no-op Accessibility press as proof of a DOM mouse effect",
  );
  assert(
    swift.includes("func postKey(processId: Int32, code: CGKeyCode")
      && swift.includes("func postUnicode(processId: Int32, _ text: String)")
      && swift.includes("func postKeyChord(processId: Int32, _ keys: [String])")
      && swift.includes("postKeyChord(processId: request.candidate.processId")
      && swift.includes("postUnicode(processId: request.candidate.processId"),
    "bounded keyboard and Unicode input must post only to the exact candidate process",
  );
  assert.match(
    swift,
    /func postKey\(processId: Int32[\s\S]*?down\.postToPid\(pid_t\(processId\)\)\s+Thread\.sleep\(forTimeInterval: 0\.025\)\s+up\.postToPid\(pid_t\(processId\)\)/,
    "bounded key chords must retain a short key-down dwell",
  );
  assert.match(
    swift,
    /func postUnicode\(processId: Int32[\s\S]*?down\.postToPid\(pid_t\(processId\)\)\s+Thread\.sleep\(forTimeInterval: 0\.025\)\s+up\.postToPid\(pid_t\(processId\)\)/,
    "bounded Unicode entry must retain a short key-down dwell",
  );
  assert(build.includes('spawnSync("/usr/bin/xcrun"'));
  assert(build.includes('"swiftc"'));
  assert(build.includes("shellx-final-webdriver-"));
  assert(build.includes("signed: false"));
  assert(build.includes("installedIntoApplication: false"));
  assert(proof.includes('flag: "wx"'), "binding evidence must be create-only");
  assert(proof.includes('process.platform !== "darwin"'), "live proof must be pinned to the candidate Mac host");
  assert(!packageJson.includes("macos-release-input.swift"), "the shipping package must not import the helper source");
  assert(!tauriLib.includes("macos-release-input"), "the shipping Tauri app must not register a test-only helper/plugin");
  assert.equal(
    relative(root, swiftPath).replaceAll("\\", "/"),
    "scripts/native/macos-release-input.swift",
    "the helper must remain external release tooling",
  );
}

function candidateFixture(debugTokenPath: string): ReleaseSurfaceCandidateAttestation {
  return {
    schema: "shellx/release-surface-candidate-attestation@5",
    mode: "final-frozen-candidate",
    platform: "macos-installed",
    sourceCommit: "b".repeat(40),
    version: "0.3.5",
    createdAt: "2026-07-29T01:00:00.000Z",
    distributionArtifact: { basename: "shellX.dmg", sha256: "e".repeat(64), bytes: 500 },
    installation: {
      method: "installer-observed",
      sourceArtifactSha256: "e".repeat(64),
      receipt: { basename: "installation.json", sha256: "c".repeat(64), bytes: 200 },
      payloadManifestSha256: "d".repeat(64),
    },
    installedPayload: {
      basename: "shellX",
      sha256: "a".repeat(64),
      bytes: 100,
      path: "/Applications/shellX.app/Contents/MacOS/shellX",
    },
    process: {
      pid: 4321,
      executablePath: "/Applications/shellX.app/Contents/MacOS/shellX",
      executableSha256: "a".repeat(64),
    },
    runtime: {
      debugBase: "http://127.0.0.1:30123",
      debugPort: 30123,
      debugTokenPath,
      mcpBase: "http://127.0.0.1:30124",
      mcpPort: 30124,
      mcpTokenPath: "/tmp/mcp.token",
      processId: 4321,
      instanceId: "fixture-instance-0001",
      appVersion: "0.3.5",
      buildCommit: "b".repeat(40),
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
