import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  RELEASE_SURFACE_DRIVER_REPORT_SCHEMA,
  RELEASE_SURFACE_DRIVER_REQUEST_SCHEMA,
  completionTimestamp,
  releaseSurfaceCleanupProofSha256,
  releaseSurfaceDriverPhaseReportPassed,
  sealReleaseSurfaceDriverReport,
  validateReleaseSurfaceDriverRequest,
  validateReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverManifest,
  type ReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverRequest,
} from "./lib/release-surface-driver-protocol";
import {
  releaseSurfaceControllerBindingFixture,
  releaseSurfaceFixtureSourceCommit,
} from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";
import { releaseSurfacePosixPathDigest } from "./lib/release-surface-posix-native-runtime";

const root = resolve(import.meta.dirname, "..");
const fixtureDriver = resolve(root, "scripts/fixtures/release-surface-driver-fixture.ts");
const described = spawnSync(process.execPath, ["--import", "tsx", fixtureDriver, "--describe"], {
  cwd: root,
  encoding: "utf8",
});
assert.equal(described.status, 0, described.stderr);
const manifest = JSON.parse(described.stdout) as ReleaseSurfaceDriverManifest;
assert.equal(manifest.schema, RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA);
assert.equal(manifest.id, "fixture-installed");
assert.equal(manifest.invocationTransport, "process-cli");
assert.equal(
  completionTimestamp("2026-07-28T18:00:00.000Z", Date.parse("2026-07-28T17:59:59.000Z")),
  "2026-07-28T18:00:00.000Z",
  "release evidence completion time must remain ordered across wall-clock corrections",
);

const request: ReleaseSurfaceDriverRequest = {
  schema: RELEASE_SURFACE_DRIVER_REQUEST_SCHEMA,
  mode: "final-frozen-candidate",
  driverId: manifest.id,
  driverKind: manifest.kind,
  platform: "windows-installed",
  sourceCommit: releaseSurfaceFixtureSourceCommit,
  version: "0.3.5",
  inventoryDigest: "a".repeat(64),
  artifact: { basename: "ShellX.exe", sha256: "c".repeat(64) },
  controller: releaseSurfaceControllerBindingFixture("scripts/fixtures/release-surface-driver-fixture.ts"),
  runtime: {
    processId: 4321,
    instanceId: "fixture-instance-0001",
    debugBase: "http://127.0.0.1:30123",
    debugTokenPath: "C:\\Temp\\shellx-final\\shellxagent.token",
    mcpBase: "http://127.0.0.1:30124",
    mcpTokenPath: "C:\\Temp\\shellx-final\\mcp.token",
    executableSha256: "d".repeat(64),
    installedPayloadPath: "C:\\Program Files\\ShellX\\shellx.exe",
    installedManifestSha256: "e".repeat(64),
    windowsNative: {
      schema: "shellx/release-surface-windows-native-binding@1",
      process: {
        pid: 4321,
        startId: "2026-07-28T17:59:00.000Z",
        imagePath: "C:\\Program Files\\ShellX\\shellx.exe",
        imageSha256: "d".repeat(64),
        imageBytes: 1024,
        imageFileId: "abcd1234:0x00000000000000000000000000000001",
      },
      listener: { address: "127.0.0.1", port: 30123, owningPid: 4321 },
    },
  },
  assignments: [{
    surface: {
      id: "tauri-command:fixture",
      kind: "tauri-command",
      name: "fixture",
      source: "fixture.rs",
      platforms: ["windows-installed", "macos-installed", "linux-installed"],
      delivery: "installed-app",
    },
    fixtureId: "fixture:isolated-profile",
    expectedEffect: "fixture returned its isolated result",
    oracleId: "fixture:isolated-result",
    cleanupId: "fixture:remove-isolated-profile",
  }],
};
assert.deepEqual(validateReleaseSurfaceDriverRequest(manifest, request), []);
const missingMcp = structuredClone(request);
missingMcp.runtime.mcpBase = "";
missingMcp.runtime.mcpTokenPath = "";
assert(
  validateReleaseSurfaceDriverRequest(manifest, missingMcp)
    .some((error) => error.includes("mcpBase")),
  "driver requests must fail closed without the attested Host MCP binding",
);
const missingNative = structuredClone(request);
delete missingNative.runtime.windowsNative;
assert(
  validateReleaseSurfaceDriverRequest(manifest, missingNative)
    .some((error) => error.includes("native process and listener")),
  "Windows driver requests must fail closed without native runtime binding",
);
const foreignNative = structuredClone(request);
foreignNative.platform = "linux-installed";
assert(
  validateReleaseSurfaceDriverRequest(manifest, foreignNative)
    .some((error) => error.includes("not valid for a non-Windows")),
  "non-Windows requests must reject Windows-native runtime binding",
);
const nativeManifest: ReleaseSurfaceDriverManifest = {
  schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  id: "native-palette-fixture",
  kind: "palette-action",
  runtimeBinding: "attested-process",
  invocationTransport: "native-installed-input",
  supportedFixtures: ["palette:native-fixture"],
  supportedCleanups: ["palette:restore-baseline"],
  supportedOracles: ["palette:native-effect"],
};
const nativeRequest: ReleaseSurfaceDriverRequest = {
  ...structuredClone(request),
  driverId: nativeManifest.id,
  driverKind: nativeManifest.kind,
  platform: "linux-installed",
  runtime: {
    ...structuredClone(request.runtime),
    windowsNative: undefined,
    posixNative: {
      schema: "shellx/release-surface-posix-native-binding@1",
      platform: "linux",
      process: {
        pid: 4321,
        startId: "linux:12345678-1234-1234-1234-123456789abc:1000",
        imageBasename: "shellx.exe",
        imagePathSha256: releaseSurfacePosixPathDigest(request.runtime.installedPayloadPath),
        imageSha256: request.runtime.executableSha256,
        imageBytes: 1024,
        imageFileId: "8:1234",
      },
      listener: { address: "127.0.0.1", port: 30123, owningPid: 4321, socketId: "inode:12345" },
    },
  },
  assignments: [{
    surface: {
      id: "palette-action:native-fixture",
      kind: "palette-action",
      name: "native-fixture",
      source: "fixture.tsx",
      platforms: ["linux-installed"],
      delivery: "installed-app",
    },
    fixtureId: "palette:native-fixture",
    expectedEffect: "native palette action changed exact state",
    oracleId: "palette:native-effect",
    cleanupId: "palette:restore-baseline",
  }],
};
assert(
  validateReleaseSurfaceDriverRequest(nativeManifest, nativeRequest)
    .some((error) => error.includes("same-process session binding")),
  "native user-action drivers must fail closed without a same-process WebDriver session",
);
nativeRequest.nativeWebDriver = {
  base: "http://127.0.0.1:30444",
  sessionId: "native-session-0001",
  evidence: { basename: "native-webdriver-binding.json", sha256: "f".repeat(64), bytes: 1024 },
};
assert.deepEqual(validateReleaseSurfaceDriverRequest(nativeManifest, nativeRequest), []);
const macosNativeRequest = structuredClone(nativeRequest);
macosNativeRequest.platform = "macos-installed";
macosNativeRequest.assignments[0]!.surface.platforms = ["macos-installed"];
macosNativeRequest.runtime.debugTokenPath = "/private/tmp/shellx-final-webdriver-0123456789abcdef/.shellx/debug.token";
macosNativeRequest.runtime.mcpTokenPath = "/private/tmp/shellx-final-webdriver-0123456789abcdef/.shellx/mcp.token";
macosNativeRequest.runtime.installedPayloadPath = "/Applications/shellX.app/Contents/MacOS/shellx";
macosNativeRequest.runtime.posixNative = releaseSurfacePosixNativeBindingFixture({
  processId: macosNativeRequest.runtime.processId,
  port: Number(new URL(macosNativeRequest.runtime.debugBase).port),
  imagePath: macosNativeRequest.runtime.installedPayloadPath,
  imageSha256: macosNativeRequest.runtime.executableSha256,
  platform: "macos",
});
delete macosNativeRequest.nativeWebDriver;
macosNativeRequest.macosNativeInput = {
  helperPath: "/private/tmp/shellx-final-webdriver-0123456789abcdef/shellx-release-macos-native-input",
  expectedWindowTitle: "shellX",
  windowNumber: 71,
  helper: { basename: "shellx-release-macos-native-input", sha256: "1".repeat(64), bytes: 4096 },
  evidence: { basename: "macos-native-input-binding.json", sha256: "2".repeat(64), bytes: 2048 },
};
assert.deepEqual(validateReleaseSurfaceDriverRequest(nativeManifest, macosNativeRequest), []);
const missingMacosBinding = structuredClone(macosNativeRequest);
delete missingMacosBinding.macosNativeInput;
assert(
  validateReleaseSurfaceDriverRequest(nativeManifest, missingMacosBinding)
    .some((error) => error.includes("exact helper binding receipt")),
  "macOS installed-input drivers must fail closed without an operator-granted helper binding receipt",
);
const mixedMacosBinding = structuredClone(macosNativeRequest);
mixedMacosBinding.nativeWebDriver = structuredClone(nativeRequest.nativeWebDriver);
assert(
  validateReleaseSurfaceDriverRequest(nativeManifest, mixedMacosBinding)
    .some((error) => error.includes("must not receive a native WebDriver")),
  "macOS installed-input drivers must reject mixed helper and WebDriver capabilities",
);
const leakedSession = structuredClone(request);
leakedSession.nativeWebDriver = structuredClone(nativeRequest.nativeWebDriver);
assert(
  validateReleaseSurfaceDriverRequest(manifest, leakedSession)
    .some((error) => error.includes("must not receive")),
  "non-WebDriver drivers must not receive a native session capability",
);

const temp = mkdtempSync(join(tmpdir(), "shellx-final-driver-protocol-"));
try {
  const requestPath = join(temp, "request.json");
  const outputPath = join(temp, "report.json");
  writeFileSync(requestPath, JSON.stringify(request), "utf8");
  const run = spawnSync(process.execPath, [
    "--import", "tsx", fixtureDriver,
    "--request", requestPath,
    "--out", outputPath,
  ], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(readFileSync(outputPath, "utf8")) as ReleaseSurfaceDriverReport;
  assert.equal(report.schema, RELEASE_SURFACE_DRIVER_REPORT_SCHEMA);
  assert.deepEqual(validateReleaseSurfaceDriverReport(request, report), []);
  assert.equal(report.outcomes[0]?.expectedEffect, request.assignments[0]?.expectedEffect);
  assert.equal(report.outcomes[0]?.oracleId, "fixture:isolated-result");
  assert.equal(report.outcomes[0]?.observedEffect, request.assignments[0]?.expectedEffect);
  assert.equal(report.outcomes[0]?.cleanupEvidence?.cleanupId, request.assignments[0]?.cleanupId);
  assert.equal(report.outcomes[0]?.cleanupEvidence?.privatePayloadRetained, false);

  const teardownRequest = structuredClone(request);
  teardownRequest.assignments[0]!.cleanupId = "tauri:discard-with-candidate-profile";
  const teardownReport = sealReleaseSurfaceDriverReport(teardownRequest, structuredClone(report));
  assert.equal(teardownReport.outcomes[0]?.cleanup, "deferred-candidate-teardown");
  assert.equal(teardownReport.outcomes[0]?.cleanupEvidence?.status, "deferred-candidate-teardown");
  assert.deepEqual(validateReleaseSurfaceDriverReport(teardownRequest, teardownReport), []);
  assert.equal(releaseSurfaceDriverPhaseReportPassed(teardownReport), true);

  const forgedTeardownPass = structuredClone(teardownReport);
  forgedTeardownPass.outcomes[0]!.cleanup = "pass";
  forgedTeardownPass.outcomes[0]!.cleanupEvidence!.status = "pass";
  forgedTeardownPass.outcomes[0]!.cleanupEvidence!.proofSha256 = releaseSurfaceCleanupProofSha256(
    teardownRequest,
    forgedTeardownPass.outcomes[0]!.id,
    teardownRequest.assignments[0]!.cleanupId,
    "pass",
  );
  assert(
    validateReleaseSurfaceDriverReport(teardownRequest, forgedTeardownPass)
      .some((error) => error.includes("cannot pass candidate teardown")),
    "a live driver report must not claim candidate teardown already passed",
  );

  const unrelatedDeferred = structuredClone(report);
  unrelatedDeferred.outcomes[0]!.cleanup = "deferred-candidate-teardown";
  unrelatedDeferred.outcomes[0]!.cleanupEvidence!.status = "deferred-candidate-teardown";
  unrelatedDeferred.outcomes[0]!.cleanupEvidence!.proofSha256 = releaseSurfaceCleanupProofSha256(
    request,
    unrelatedDeferred.outcomes[0]!.id,
    request.assignments[0]!.cleanupId,
    "deferred-candidate-teardown",
  );
  assert(
    validateReleaseSurfaceDriverReport(request, unrelatedDeferred)
      .some((error) => error.includes("unrelated cleanup")),
    "only the exact candidate-dependent cleanup allowlist may defer to teardown",
  );

  const injected = structuredClone(report) as ReleaseSurfaceDriverReport & { privatePayload?: unknown };
  injected.privatePayload = { token: "must-not-be-retained" };
  assert(
    validateReleaseSurfaceDriverReport(request, injected).some((error) => error.includes("undeclared field privatePayload")),
    "driver reports must reject undeclared private payload fields",
  );
  const forgedCleanup = structuredClone(report);
  forgedCleanup.outcomes[0]!.cleanupEvidence!.proofSha256 = "0".repeat(64);
  assert(
    validateReleaseSurfaceDriverReport(request, forgedCleanup).some((error) => error.includes("cleanup proof")),
    "cleanup evidence must be bound to the exact candidate, assignment, and verdict",
  );
  const rawFailure = structuredClone(report);
  rawFailure.outcomes[0]!.effect = "fail";
  rawFailure.outcomes[0]!.error = "Bearer private-token-value-that-must-never-be-retained";
  const sealedFailure = sealReleaseSurfaceDriverReport(request, rawFailure);
  assert.match(sealedFailure.outcomes[0]!.error ?? "", /^redacted-error-sha256:[a-f0-9]{64}$/);
  assert(!JSON.stringify(sealedFailure).includes("private-token-value"));
  assert.deepEqual(validateReleaseSurfaceDriverReport(request, sealedFailure), []);

  const rawTeardownFailure = structuredClone(report);
  rawTeardownFailure.outcomes[0]!.effect = "fail";
  rawTeardownFailure.outcomes[0]!.cleanup = "pass";
  rawTeardownFailure.outcomes[0]!.error = "private candidate action failure";
  const sealedTeardownFailure = sealReleaseSurfaceDriverReport(
    teardownRequest,
    rawTeardownFailure,
  );
  assert.equal(
    sealedTeardownFailure.outcomes[0]!.cleanup,
    "fail",
    "a failed action cannot claim or defer the still-required candidate teardown",
  );
  assert.equal(sealedTeardownFailure.outcomes[0]!.cleanupEvidence!.status, "fail");
  assert.match(
    sealedTeardownFailure.outcomes[0]!.error ?? "",
    /^redacted-error-sha256:[a-f0-9]{64}$/,
  );
  assert(!JSON.stringify(sealedTeardownFailure).includes("private candidate action failure"));
  assert.deepEqual(validateReleaseSurfaceDriverReport(teardownRequest, sealedTeardownFailure), []);
  assert.equal(releaseSurfaceDriverPhaseReportPassed(sealedTeardownFailure), false);

  const forbiddenMutationPath = join(temp, "overwrite-driver-entered.txt");
  const overwrite = spawnSync(process.execPath, [
    "--import", "tsx", fixtureDriver,
    "--request", requestPath,
    "--out", outputPath,
  ], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      SHELLX_RELEASE_FIXTURE_MUTATE_INSTALLED_PATH: forbiddenMutationPath,
    },
  });
  assert.notEqual(overwrite.status, 0, "driver evidence must never overwrite an existing report");
  assert.match(`${overwrite.stderr}\n${overwrite.stdout}`, /release driver output already exists/i);
  assert.equal(
    existsSync(forbiddenMutationPath),
    false,
    "an existing create-only output must be rejected before the release driver executes",
  );

  const missing = structuredClone(report);
  missing.outcomes = [];
  assert(
    validateReleaseSurfaceDriverReport(request, missing).some((error) => error.includes("missing requested outcome")),
    "driver report must contain every requested exact surface",
  );
  const unknown = structuredClone(report);
  unknown.outcomes[0]!.id = "tauri-command:not-requested";
  const unknownErrors = validateReleaseSurfaceDriverReport(request, unknown);
  assert(unknownErrors.some((error) => error.includes("was not requested")));
  assert(unknownErrors.some((error) => error.includes("missing requested outcome")));

  const unbound = structuredClone(report);
  unbound.outcomes[0]!.expectedEffect = "a different expectation";
  unbound.outcomes[0]!.oracleId = "";
  const unboundErrors = validateReleaseSurfaceDriverReport(request, unbound);
  assert(
    unboundErrors.some((error) => error.includes("expectedEffect must match the exact assignment")),
    "driver evidence must stay bound to the assignment's exact intended effect",
  );
  assert(
    unboundErrors.some((error) => error.includes("must name the effect oracle")),
    "driver evidence must identify the oracle that judged the intended effect",
  );
  const wrongRuntime = structuredClone(report);
  wrongRuntime.runtime.instanceId = "different-instance-01";
  assert(
    validateReleaseSurfaceDriverReport(request, wrongRuntime).some((error) => error.includes("runtime must match")),
    "driver evidence from a different process instance must be rejected",
  );
  const forgedNativeSession = structuredClone(report);
  forgedNativeSession.nativeWebDriver = structuredClone(nativeRequest.nativeWebDriver);
  assert(
    validateReleaseSurfaceDriverReport(request, forgedNativeSession)
      .some((error) => error.includes("nativeWebDriver must match")),
    "driver reports cannot add or rewrite a WebDriver session binding",
  );
} finally {
  rmSync(temp, { recursive: true });
}

const browserHelpDriver = resolve(root, "scripts/release-drivers/browser-cli-command-installed.ts");
const browserTemp = mkdtempSync(join(tmpdir(), "shellx-browser-help-driver-"));
try {
  const browserRequest: ReleaseSurfaceDriverRequest = {
    ...request,
    driverId: "browser-cli-command-installed",
    driverKind: "browser-cli-command",
    controller: releaseSurfaceControllerBindingFixture(
      "scripts/release-drivers/browser-cli-command-installed.ts",
      ["scripts/shellx-browser-cli.ts"],
    ),
    assignments: ["help", "--help", "-h"].map((name) => ({
      surface: {
        id: `browser-cli-command:${name}`,
        kind: "browser-cli-command",
        name,
        source: "scripts/shellx-browser-cli.ts",
        platforms: ["windows-installed", "macos-installed", "linux-installed"],
        delivery: "source-package",
      },
      fixtureId: "browser-cli:help-json",
      expectedEffect: `${name} returns structured usage`,
      oracleId: name === "-h" ? "browser-cli:h:schema" : "browser-cli:help:schema",
      cleanupId: "browser-cli:read-only",
    })),
  };
  const requestPath = join(browserTemp, "request.json");
  const outputPath = join(browserTemp, "report.json");
  writeFileSync(requestPath, JSON.stringify(browserRequest), "utf8");
  const run = spawnSync(process.execPath, [
    "--import", "tsx", browserHelpDriver,
    "--request", requestPath,
    "--out", outputPath,
  ], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(readFileSync(outputPath, "utf8")) as ReleaseSurfaceDriverReport;
  assert.deepEqual(validateReleaseSurfaceDriverReport(browserRequest, report), []);
  assert.equal(report.outcomes.length, 3);
  assert(report.outcomes.every((outcome) => outcome.effect === "pass" && outcome.cleanup === "pass"));
} finally {
  rmSync(browserTemp, { recursive: true });
}

console.log("Release surface driver protocol tests passed");
