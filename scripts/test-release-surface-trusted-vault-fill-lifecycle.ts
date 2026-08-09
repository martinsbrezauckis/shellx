import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { syntheticReleaseSurfaceControllerBinding } from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";
import {
  validateReleaseSurfaceDriverRequest,
  type ReleaseSurfaceDriverManifest,
  type ReleaseSurfaceDriverRequest,
} from "./lib/release-surface-driver-protocol";
import type { ReleaseSurfaceInventory } from "./lib/release-surface-inventory";
import {
  releaseSurfaceDriverRequiresNativeWebDriver,
  releaseSurfaceDriverSupportsMacosNativeInput,
} from "./lib/release-surface-webdriver-binding";
import {
  TRUSTED_VAULT_FILL_CLEANUPS,
  TRUSTED_VAULT_FILL_FIXTURES,
  TRUSTED_VAULT_FILL_ORACLES,
  TRUSTED_VAULT_FILL_SURFACE_IDS,
  trustedVaultGrantRequest,
  trustedVaultFillAction,
  validateTrustedVaultResetResponse,
} from "./release-drivers/trusted-vault-fill-lifecycle";

const root = resolve(import.meta.dirname, "..");
const rawSecret = "SHELLX_RELEASE_TRUSTED_VAULT_FILL_SECRET_035";
const rawProfile = "shellx-release-profile@example.test";
const expected = new Map<string, {
  driverId: string;
  fixtureId: (typeof TRUSTED_VAULT_FILL_FIXTURES)[number];
  oracleId: (typeof TRUSTED_VAULT_FILL_ORACLES)[number];
  cleanupId: (typeof TRUSTED_VAULT_FILL_CLEANUPS)[number];
}>([
  ["debug-api-route:POST /release-test/browser/trusted-vault-fixture", {
    driverId: "debug-api-route-installed",
    fixtureId: "vault-fill:trusted-https-fixed-child-webview",
    oracleId: "vault-fill:release-fixture-route:redacted-form-and-proof",
    cleanupId: "vault-fill:close-owned-route-task",
  }],
  ["browser-cli-command:fill-from-vault", {
    driverId: "browser-cli-trusted-vault-fill-installed",
    fixtureId: "vault-fill:trusted-https-agent-secret",
    oracleId: "vault-fill:browser-cli:trusted-field-hash",
    cleanupId: "vault-fill:reset-isolated-vault-close-owned-task-and-restore-autonomy",
  }],
  ["host-mcp-tool:browser_fill_from_vault", {
    driverId: "host-mcp-trusted-vault-fill-installed",
    fixtureId: "vault-fill:trusted-https-agent-secret",
    oracleId: "vault-fill:host-mcp-secret:trusted-field-hash",
    cleanupId: "vault-fill:reset-isolated-vault-close-owned-task-and-restore-autonomy",
  }],
  ["host-mcp-tool:browser_fill_profile_card", {
    driverId: "host-mcp-trusted-vault-fill-installed",
    fixtureId: "vault-fill:trusted-https-profile-card",
    oracleId: "vault-fill:host-mcp-profile:trusted-field-hash",
    cleanupId: "vault-fill:reset-isolated-vault-close-owned-task-and-restore-autonomy",
  }],
  ["tauri-command:shellx_browser_fill_user_vault_secret", {
    driverId: "tauri-command-trusted-vault-fill-installed",
    fixtureId: "vault-fill:trusted-https-user-suggestion",
    oracleId: "vault-fill:tauri-user-secret:trusted-field-hash",
    cleanupId: "vault-fill:reset-isolated-vault-close-owned-user-tab-and-restore-browser",
  }],
  ['ui-control:src/browser/components/BrowserChrome.tsx:[data-debug-id="shellx-browser-vault-fill-menu"]@src/browser/components/BrowserChrome.tsx#18', {
    driverId: "ui-control-trusted-vault-fill-installed",
    fixtureId: "vault-fill:trusted-https-user-suggestion",
    oracleId: "ui:disclosure-state-transition",
    cleanupId: "vault-fill:reset-isolated-vault-close-owned-user-tab-and-restore-browser",
  }],
  ['ui-control:src/browser/components/BrowserVaultFillPanel.tsx:[data-debug-id="shellx-browser-vault-fill-suggestion"]@src/browser/components/BrowserVaultFillPanel.tsx#1', {
    driverId: "ui-control-trusted-vault-fill-installed",
    fixtureId: "vault-fill:trusted-https-user-suggestion",
    oracleId: "ui:activation:vault-fill-trusted-field-hash",
    cleanupId: "vault-fill:reset-isolated-vault-close-owned-user-tab-and-restore-browser",
  }],
  ["ui-debug-surface:shellx-browser-vault-fill-menu@src/browser/components/BrowserChrome.tsx#21", debugMarker()],
  ["ui-debug-surface:shellx-browser-vault-fill-badge@src/browser/components/BrowserChrome.tsx#22", debugMarker()],
  ["ui-debug-surface:shellx-browser-vault-fill-panel@src/browser/components/BrowserVaultFillPanel.tsx#1", debugMarker()],
  ["ui-debug-surface:shellx-browser-vault-fill-suggestion@src/browser/components/BrowserVaultFillPanel.tsx#3", debugMarker()],
]);

const planText = readFileSync(resolve(root, "release/surface-driver-plan.json"), "utf8");
const plan = JSON.parse(planText) as {
  drivers: Array<{ id: string; kind: string; entrypoint: string; platforms: Record<string, string> }>;
  assignments: Array<{
    surfaceId: string;
    driverId: string;
    fixtureId: string;
    expectedEffect: string;
    oracleId: string;
    cleanupId: string;
  }>;
};
const inventory = JSON.parse(readFileSync(resolve(root, "release/surface-inventory.json"), "utf8")) as ReleaseSurfaceInventory;
assert.deepEqual([...TRUSTED_VAULT_FILL_SURFACE_IDS].sort(), [...expected.keys()].sort());
assert.equal(expected.size, 11);
assert.equal([...expected.keys()].filter((id) => id.startsWith("debug-api-route:")).length, 1);
assert.equal([...expected.keys()].filter((id) => id.startsWith("browser-cli-command:")).length, 1);
assert.equal([...expected.keys()].filter((id) => id.startsWith("host-mcp-tool:")).length, 2);
assert.equal([...expected.keys()].filter((id) => id.startsWith("tauri-command:")).length, 1);
assert.equal([...expected.keys()].filter((id) => id.startsWith("ui-control:")).length, 2);
assert.equal([...expected.keys()].filter((id) => id.startsWith("ui-debug-surface:")).length, 4);

for (const [surfaceId, contract] of expected) {
  assert(trustedVaultFillAction(surfaceId), `trusted fill action routing is absent for ${surfaceId}`);
  const assignment = plan.assignments.find((row) => row.surfaceId === surfaceId);
  assert(assignment, `trusted fill plan assignment is absent for ${surfaceId}`);
  assert.equal(assignment.driverId, contract.driverId);
  assert.equal(assignment.fixtureId, contract.fixtureId);
  assert.equal(assignment.oracleId, contract.oracleId);
  assert.equal(assignment.cleanupId, contract.cleanupId);
  assert(!assignment.expectedEffect.startsWith("BUILDING:"));
  assert(!assignment.expectedEffect.includes(rawSecret));
  assert(!assignment.expectedEffect.includes(rawProfile));
}
assert(!planText.includes(rawSecret));
assert(!planText.includes(rawProfile));

assert.doesNotThrow(() => validateTrustedVaultResetResponse({
  ok: true,
  receipt: { action: "vaultE2eReset", secretExposed: false },
}, "contract reset"));
assert.throws(
  () => validateTrustedVaultResetResponse({ ok: true, secretExposed: false }, "contract reset"),
  /isolated Vault contract reset receipt must be an object/,
);
assert.throws(
  () => validateTrustedVaultResetResponse({
    ok: true,
    receipt: { action: "vaultE2eReset", secretExposed: true },
  }, "contract reset"),
  /isolated Vault contract reset failed closed/,
);

assert.deepEqual(
  trustedVaultGrantRequest("release/secret", "fill", 123_456),
  {
    secretRef: "release/secret",
    actorScope: { kind: "allShellxAgents" },
    operation: "fill",
    origin: "https://example.com",
    expiresAtMs: 123_456,
  },
  "trusted browser-fill grants must carry the exact fixture origin",
);
assert.deepEqual(
  trustedVaultGrantRequest("release/profile", "profileFill", 654_321),
  {
    secretRef: "release/profile",
    actorScope: { kind: "allShellxAgents" },
    operation: "profileFill",
    origin: "https://example.com",
    expiresAtMs: 654_321,
  },
  "trusted profile-fill grants must carry the exact fixture origin",
);

const driverContracts = [
  ["browser-cli-trusted-vault-fill-installed", "browser-cli-command", "process-cli", false, false],
  ["host-mcp-trusted-vault-fill-installed", "host-mcp-tool", "process-cli", false, false],
  ["tauri-command-trusted-vault-fill-installed", "tauri-command", "debug-api-direct", false, false],
  ["ui-control-trusted-vault-fill-installed", "ui-control", "native-installed-input", true, true],
  ["ui-debug-surface-trusted-vault-fill-installed", "ui-debug-surface", "native-installed-input", true, true],
] as const;

for (const [driverId, kind, transport, needsMacInput, needsWindowsLinuxWebDriver] of driverContracts) {
  const driver = plan.drivers.find((row) => row.id === driverId);
  assert(driver, `trusted fill driver is absent: ${driverId}`);
  assert.equal(driver.kind, kind);
  assert.deepEqual(driver.platforms, {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  });
  const described = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, driver.entrypoint), "--describe",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(described.status, 0, described.stderr || described.stdout);
  const manifest = JSON.parse(described.stdout) as ReleaseSurfaceDriverManifest;
  assert.equal(manifest.id, driverId);
  assert.equal(manifest.kind, kind);
  assert.equal(manifest.invocationTransport, transport);
  assert.deepEqual(manifest.supportedFixtures, [...TRUSTED_VAULT_FILL_FIXTURES]);
  assert.deepEqual(manifest.supportedCleanups, [...TRUSTED_VAULT_FILL_CLEANUPS]);
  assert.deepEqual(manifest.supportedOracles, [...TRUSTED_VAULT_FILL_ORACLES]);
  assert.equal(releaseSurfaceDriverRequiresNativeWebDriver(driverId, kind, "windows-installed"), needsWindowsLinuxWebDriver);
  assert.equal(releaseSurfaceDriverRequiresNativeWebDriver(driverId, kind, "linux-installed"), needsWindowsLinuxWebDriver);
  assert.equal(releaseSurfaceDriverRequiresNativeWebDriver(driverId, kind, "macos-installed"), false);
  assert.equal(releaseSurfaceDriverSupportsMacosNativeInput(driverId, kind), needsMacInput);
  const surfaceId = [...expected].find(([, value]) => value.driverId === driverId)?.[0];
  assert(surfaceId);
  const surface = inventory.items.find((item) => item.id === surfaceId);
  const assignment = plan.assignments.find((item) => item.surfaceId === surfaceId);
  assert(surface && assignment);
  const unbound = requestWithoutNativeBinding(manifest, surface, assignment);
  assert.equal(
    validateReleaseSurfaceDriverRequest(manifest, unbound)
      .includes("native WebDriver drivers require a same-process session binding"),
    needsWindowsLinuxWebDriver,
    `${driverId} native WebDriver requirement must match its actual installed-input transport`,
  );
  if (needsMacInput) {
    const macUnbound = requestWithoutNativeBinding(manifest, surface, assignment, true);
    const errors = validateReleaseSurfaceDriverRequest(manifest, macUnbound);
    assert(!errors.includes("native WebDriver drivers require a same-process session binding"));
    assert(errors.includes("macOS native-input drivers require an exact helper binding receipt"));
  }
}

const lifecycleSource = readFileSync(
  resolve(root, "scripts/release-drivers/trusted-vault-fill-lifecycle.ts"),
  "utf8",
);
const fixtureRouteSource = readFileSync(
  resolve(root, "src-tauri/src/debug_api_release_browser_fixture.rs"),
  "utf8",
);
const fixtureRouteProductionSource = fixtureRouteSource.split("#[cfg(test)]", 1)[0] ?? fixtureRouteSource;
for (const required of [
  'const TRUSTED_ORIGIN = "https://example.com"',
  'security.level !== "secure"',
  "security.credentialEntryAllowed !== true",
  '"/release-test/browser/trusted-vault-fixture"',
  '"/vault/e2e/reset"',
  '"/vault/e2e/approve-grant"',
  '"/release-test/tauri-invokes"',
  '"browser_fill_from_vault"',
  '"browser_fill_profile_card"',
  '"shellx_browser_fill_user_vault_secret"',
  "rejectRawValues",
  "cleanupOwnedBrowserLifecycle",
]) {
  assert(lifecycleSource.includes(required), `trusted fill lifecycle omitted ${required}`);
}
const hostMcpLifecycleSource = lifecycleSource.slice(
  lifecycleSource.indexOf("async function exerciseHostMcp"),
  lifecycleSource.indexOf("async function exerciseTauri"),
);
assert.match(
  hostMcpLifecycleSource,
  /callMcpTool\(mcp, "browser_observe",[\s\S]*?observedRefId\(observed, selector\)[\s\S]*?refId,/,
  "Host MCP trusted fill must observe and bind the exact current Browser ref before using a Vault grant",
);
const cleanupLifecycleSource = lifecycleSource.slice(
  lifecycleSource.indexOf("async function cleanupLifecycle"),
  lifecycleSource.indexOf("async function resetVault"),
);
assert.match(
  cleanupLifecycleSource,
  /state\.autonomy\?\.tabId[\s\S]*?"X-ShellX-MCP-Caller-ID"[\s\S]*?cleanupOwnedBrowserLifecycle/,
  "Host MCP trusted fill cleanup must preserve the caller identity of its owned Browser task",
);
for (const required of [
  'location.origin !== expectedOrigin',
  '!window.isSecureContext',
  'crypto.subtle.digest("SHA-256"',
  'deny_unknown_fields',
  '"release_test_route_unavailable"',
  'tab.security_state.credential_entry_allowed',
  'eval_browser_engine_json',
  'secretExposed: false',
]) {
  assert(fixtureRouteSource.includes(required), `fixed child-webview fixture route omitted ${required}`);
}
for (const forbidden of [
  "arguments[",
  "hash: element ? String(element.value",
  "value: element",
  "browser/developer-mode/approval",
]) {
  assert(!fixtureRouteProductionSource.includes(forbidden), `fixed child-webview fixture route contains forbidden capability ${forbidden}`);
}
assert(!lifecycleSource.includes("waitForTrustedOriginHandle"));
assert(!lifecycleSource.includes("executeReleaseSurfaceWebDriverScript"));
for (const forbidden of [
  "accept_invalid_certs",
  "danger_accept_invalid",
  "certificate trust install",
  "private key",
  "vault/reveal",
  "navigator.clipboard",
]) {
  assert(!lifecycleSource.toLowerCase().includes(forbidden), `trusted fill lifecycle contains forbidden boundary ${forbidden}`);
}

console.log("Release trusted HTTPS Vault fill lifecycle contracts passed (11 surfaces; 5 bound drivers plus fixed route)");

function debugMarker() {
  return {
    driverId: "ui-debug-surface-trusted-vault-fill-installed",
    fixtureId: "vault-fill:trusted-https-user-suggestion" as const,
    oracleId: "vault-fill:ui-markers:trusted-suggestion-state" as const,
    cleanupId: "vault-fill:reset-isolated-vault-close-owned-user-tab-and-restore-browser" as const,
  };
}

function requestWithoutNativeBinding(
  manifest: ReleaseSurfaceDriverManifest,
  surface: ReleaseSurfaceInventory["items"][number],
  assignment: (typeof plan.assignments)[number],
  macos = false,
): ReleaseSurfaceDriverRequest {
  const sourceCommit = "a".repeat(40);
  const executableSha256 = "b".repeat(64);
  const installedPayloadPath = "/tmp/shellx-trusted-vault-fill-fixture";
  const processId = 4321;
  const debugPort = 30123;
  return {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId: manifest.id,
    driverKind: manifest.kind,
    platform: macos ? "macos-installed" : "linux-installed",
    sourceCommit,
    version: "0.3.5",
    inventoryDigest: "c".repeat(64),
    artifact: { basename: "shellx", sha256: executableSha256 },
    controller: syntheticReleaseSurfaceControllerBinding(sourceCommit),
    runtime: {
      processId,
      instanceId: "trusted-vault-fill-fixture-instance",
      debugBase: `http://127.0.0.1:${debugPort}`,
      debugTokenPath: "/tmp/shellx-trusted-vault-fill-token",
      mcpBase: "http://127.0.0.1:30124",
      mcpTokenPath: "/tmp/shellx-trusted-vault-fill-mcp-token",
      executableSha256,
      installedPayloadPath,
      installedManifestSha256: "d".repeat(64),
      posixNative: releaseSurfacePosixNativeBindingFixture({
        processId,
        port: debugPort,
        imagePath: installedPayloadPath,
        imageSha256: executableSha256,
        platform: macos ? "macos" : "linux",
      }),
    },
    assignments: [{
      surface,
      fixtureId: assignment.fixtureId,
      expectedEffect: assignment.expectedEffect,
      oracleId: assignment.oracleId,
      cleanupId: assignment.cleanupId,
    }],
  };
}
