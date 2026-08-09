import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReleaseSurfaceDriverManifest, ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import {
  WINDOWS_DESKTOP_INTEGRATION_OBSERVATION_SCHEMA,
  observeWindowsDesktopIntegration,
  validateObservation,
} from "./release-drivers/windows-desktop-integration-lifecycle";

const root = resolve(import.meta.dirname, "..");
const exe = "C:\\Users\\Fixture\\AppData\\Local\\ShellXReleaseEvidence\\shellx-final-install-fixture\\shellx.exe";
const exeSha256 = "d".repeat(64);
const request = windowsRequest();
const observation = observationFixture("preflight-absent");
let observedCommand = "";
let observedArgs: readonly string[] = [];

const accepted = observeWindowsDesktopIntegration(request, "preflight-absent", {
  powershellPath: "fixture-powershell.exe",
  scriptPath: "C:\\fixture\\probe.ps1",
  orchestrator: "native",
  spawn(command, args) {
    observedCommand = command;
    observedArgs = args;
    return { status: 0, stdout: `${JSON.stringify(observation)}\n`, stderr: "" };
  },
});
assert.deepEqual(accepted, observation);
assert.equal(observedCommand, "fixture-powershell.exe");
for (const [flag, value] of [
  ["-Phase", "preflight-absent"],
  ["-CandidateExe", exe],
  ["-CandidateSha256", exeSha256],
  ["-CandidateProcessId", "4321"],
  ["-DebugTokenPath", "C:\\Users\\Fixture\\AppData\\Local\\ShellXReleaseEvidence\\profile\\.shellx\\shellxagent.token"],
  ["-Orchestrator", "native"],
] as const) {
  const index = observedArgs.indexOf(flag);
  assert(index >= 0, `${flag} must be supplied to the native observer`);
  assert.equal(observedArgs[index + 1], value);
}

assert.throws(
  () => observeWindowsDesktopIntegration({
    ...request,
    platform: "linux-installed",
    runtime: { ...request.runtime, windowsNative: undefined },
  }, "absent", {
    scriptPath: "C:\\fixture\\probe.ps1",
    orchestrator: "native",
    spawn() { throw new Error("non-Windows request reached the observer"); },
  }),
  /requires a native Windows candidate binding/,
);
assert.throws(
  () => observeWindowsDesktopIntegration(request, "preflight-absent", {
    scriptPath: "C:\\fixture\\probe.ps1",
    orchestrator: "native",
    spawn() {
      return {
        status: 1,
        stdout: "",
        stderr: "ShellX Explorer verbs or SendTo shortcut already exist; refusing to inspect, overwrite, or remove them",
      };
    },
  }),
  /already exist; refusing to inspect, overwrite, or remove/,
);
assert.throws(
  () => validateObservation({ ...observation, unexpected: true }, request, "preflight-absent", "native"),
  /fields are not exact/,
);
assert.throws(
  () => validateObservation({ ...observation, phase: "installed" }, request, "preflight-absent", "native"),
  /identity is invalid/,
);
assert.throws(
  () => validateObservation({ ...observation, mutated: true }, request, "preflight-absent", "native"),
  /must remain read-only/,
);
assert.throws(
  () => validateObservation({ ...observation, fileVerbInstalled: true }, request, "preflight-absent", "native"),
  /wrong fileVerbInstalled state/,
);
assert.doesNotThrow(() => validateObservation(
  observationFixture("installed"),
  request,
  "installed",
  "native",
));

const powershell = source("scripts/probe-release-surface-windows-desktop-integration.ps1");
for (const required of [
  "fresh non-admin disposable Windows user",
  "candidate process does not belong to the current disposable Windows user",
  "ShellXReleaseEvidence",
  "shellx-final-install-",
  "Registry::HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\shellX",
  "Registry::HKEY_CURRENT_USER\\Software\\Classes\\Directory\\shell\\shellX",
  "SendTo), \"shellX.lnk\"",
  "Send to shellX",
  "--attach",
  "Send files to shellX",
  "already exist; refusing to inspect, overwrite, or remove them",
  "mutated = $false",
] as const) assert(powershell.includes(required), `observer source omitted ${required}`);
assert(powershell.includes("Get-Process -Id $CandidateProcessId"));
assert(powershell.includes("OpenProcessToken"));
assert(powershell.includes("[IO.DriveInfo]::new"));
assert(!powershell.includes("Get-CimInstance"));
assert(!powershell.includes("Invoke-CimMethod"));
assert.doesNotMatch(
  powershell,
  /\b(?:Remove|Set)-Item(?:Property)?\b|\bNew-Item(?:Property)?\b|reg\.exe[^\r\n]*(?:add|delete)/i,
  "the native observer must never mutate Explorer integration state",
);

const rust = source("src-tauri/src/desktop_integration.rs");
assert(rust.includes("already has Explorer or SendTo entries"));
assert(rust.includes("partial-entry cleanup also failed"));
assert(rust.includes("remove Windows desktop integration" ) || rust.includes("remove_windows_desktop_integration"));
assert.doesNotMatch(rust, /let _ = run_reg\(\["delete"/);
assert.doesNotMatch(rust, /let _ = std::fs::remove_file/);

const nsisHooks = source("src-tauri/installer-hooks.nsh");
const preUninstall = nsisHooks.slice(
  nsisHooks.indexOf("!macro NSIS_HOOK_PREUNINSTALL"),
  nsisHooks.indexOf("!macroend", nsisHooks.indexOf("!macro NSIS_HOOK_PREUNINSTALL")) + "!macroend".length,
);
const postUninstall = nsisHooks.slice(
  nsisHooks.indexOf("!macro NSIS_HOOK_POSTUNINSTALL"),
  nsisHooks.indexOf("!macroend", nsisHooks.indexOf("!macro NSIS_HOOK_POSTUNINSTALL")) + "!macroend".length,
);
for (const [name, hook] of [["pre-uninstall", preUninstall], ["post-uninstall", postUninstall]] as const) {
  assert(hook.includes('${If} $UpdateMode <> 1'), `${name} must preserve desktop integration during updater replacement`);
  assert(hook.includes("SetShellVarContext current"), `${name} must address the uninstalling user's SendTo directory`);
  for (const ownedPath of [
    'DeleteRegKey HKCU "Software\\Classes\\*\\shell\\shellX"',
    'DeleteRegKey HKCU "Software\\Classes\\Directory\\shell\\shellX"',
    'Delete "$SENDTO\\shellX.lnk"',
  ] as const) assert(hook.includes(ownedPath), `${name} omitted owned desktop integration cleanup: ${ownedPath}`);
}

const tauriDriver = source("scripts/release-drivers/tauri-command-installed.ts");
assert(tauriDriver.indexOf('observeWindowsDesktopIntegration(request, "preflight-absent")')
  < tauriDriver.indexOf("ownsWindowsDesktopIntegration = true"));
assert(tauriDriver.includes('observeWindowsDesktopIntegration(request, "installed")'));
assert(tauriDriver.includes('observeWindowsDesktopIntegration(request, "absent")'));
assert(tauriDriver.includes('"tauri:remove-owned-windows-desktop-integration"'));

const uiDriver = source("scripts/release-drivers/ui-control-windows-desktop-integration.ts");
const uiEntrypoint = source("scripts/release-drivers/ui-control-windows-desktop-integration-installed.ts");
assert(uiDriver.indexOf('observeWindowsDesktopIntegration(request, "preflight-absent")')
  < uiDriver.indexOf("ownsIntegration = true"));
assert(uiDriver.includes("clickReleaseSurfaceInstalledInputElement"));
assert(uiDriver.includes("readDesktopIntegrationStatus"));
assert(uiDriver.includes('request.platform === "windows-installed"'));
assert(uiDriver.includes("desktop_integration_remove_windows_context_menu"));
assert.doesNotMatch(uiDriver, /debugClick|executeReleaseSurfaceInstalledInputScript/);
assert.doesNotMatch(uiEntrypoint, /request\.platform\s*!==\s*["']windows-installed["']/);
assert(uiEntrypoint.includes("createReleaseSurfaceInstalledInputSession"));

const desktopTab = source("src/components/settings/DesktopTab.tsx");
assert(desktopTab.includes("manualRefreshReceipt"));
assert(desktopTab.includes("sequence=${manualRefreshReceipt.sequence}"));
assert(desktopTab.includes('data-shellx-release-observe="disabled title"'));
assert(desktopTab.includes('data-desktop-integration-action="install"'));
assert(desktopTab.includes('data-desktop-integration-action="remove"'));
assert(desktopTab.includes('data-shellx-release-observe="title"'));
assert(desktopTab.includes("Desktop integration state: supported="));

const allowlist = source("src-tauri/src/release_tauri_command_allowlist.txt").trim().split(/\r?\n/);
assert.equal(allowlist.filter((command) => command === "desktop_integration_install_windows_context_menu").length, 1);
assert.equal(allowlist.filter((command) => command === "desktop_integration_remove_windows_context_menu").length, 1);

const plan = JSON.parse(source("release/surface-driver-plan.json")) as {
  drivers: Array<{ id: string; platforms: Record<string, string> }>;
  assignments: Array<{ surfaceId: string; driverId: string; fixtureId: string; cleanupId: string }>;
};
const uiDefinition = plan.drivers.find((driver) => driver.id === "ui-control-windows-desktop-integration-installed");
assert.deepEqual(uiDefinition?.platforms, {
  "windows-installed": "ready",
  "macos-installed": "ready",
  "linux-installed": "ready",
});
const inventory = JSON.parse(source("release/surface-inventory.json")) as {
  items: Array<{ id: string; platforms: string[] }>;
};
const desktopUiPlatforms = (surfaceName: string) => inventory.items.find((row) => (
  row.id.startsWith(`ui-control:${surfaceName}@`)
))?.platforms;
assert.deepEqual(
  desktopUiPlatforms('src/components/settings/DesktopTab.tsx:role=button;name="Install"'),
  ["windows-installed"],
);
assert.deepEqual(
  desktopUiPlatforms('src/components/settings/DesktopTab.tsx:role=button;name="Remove"'),
  ["windows-installed"],
);
assert.deepEqual(
  desktopUiPlatforms('src/components/settings/DesktopTab.tsx:[data-debug-id="surface-components-settings-desktoptab-1"]'),
  ["windows-installed", "macos-installed", "linux-installed"],
);
for (const command of [
  "desktop_integration_install_windows_context_menu",
  "desktop_integration_remove_windows_context_menu",
] as const) {
  const assignment = plan.assignments.find((row) => row.surfaceId === `tauri-command:${command}`);
  assert.equal(assignment?.driverId, "tauri-command-installed");
  assert.equal(assignment?.fixtureId, "tauri:windows-desktop-integration-empty-baseline");
  assert.equal(assignment?.cleanupId, "tauri:remove-owned-windows-desktop-integration");
}

const uiManifest = describeDriver("scripts/release-drivers/ui-control-windows-desktop-integration-installed.ts");
assert.equal(uiManifest.id, "ui-control-windows-desktop-integration-installed");
assert.equal(uiManifest.invocationTransport, "native-installed-input");
assert(uiManifest.controllerFiles?.includes("scripts/probe-release-surface-windows-desktop-integration.ps1"));
const tauriManifest = describeDriver("scripts/release-drivers/tauri-command-installed.ts");
assert(tauriManifest.supportedFixtures.includes("tauri:windows-desktop-integration-empty-baseline"));
assert(tauriManifest.supportedCleanups.includes("tauri:remove-owned-windows-desktop-integration"));
assert(tauriManifest.controllerFiles?.includes("scripts/probe-release-surface-windows-desktop-integration.ps1"));

console.log("Release surface Windows desktop integration source and fail-closed fixture tests passed");

function windowsRequest(): ReleaseSurfaceDriverRequest {
  return {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId: "tauri-command-installed",
    driverKind: "tauri-command",
    platform: "windows-installed",
    sourceCommit: "a".repeat(40),
    version: "0.3.5",
    inventoryDigest: "b".repeat(64),
    artifact: { basename: "shellx-setup.exe", sha256: "c".repeat(64) },
    controller: {
      sourceCommit: "a".repeat(40),
      sourceTreeOid: "e".repeat(40),
      node: { basename: "node", sha256: "f".repeat(64), bytes: 1024 },
      tsxLoader: { basename: "loader.mjs", sha256: "1".repeat(64), bytes: 1024 },
      entrypoint: {
        relativePath: "scripts/release-drivers/tauri-command-installed.ts",
        basename: "tauri-command-installed.ts",
        sha256: "2".repeat(64),
        bytes: 1024,
      },
      auxiliaryFiles: [],
    },
    runtime: {
      processId: 4321,
      instanceId: "fixture-windows-desktop-integration",
      debugBase: "http://127.0.0.1:5759",
      debugTokenPath: "C:\\Users\\Fixture\\AppData\\Local\\ShellXReleaseEvidence\\profile\\.shellx\\shellxagent.token",
      mcpBase: "http://127.0.0.1:5758",
      mcpTokenPath: "C:\\Users\\Fixture\\AppData\\Local\\ShellXReleaseEvidence\\profile\\.shellx\\shellxagent.mcp.token",
      executableSha256: exeSha256,
      installedPayloadPath: exe,
      installedManifestSha256: "3".repeat(64),
      windowsNative: {
        schema: "shellx/release-surface-windows-native-binding@1",
        process: {
          pid: 4321,
          startId: "2026-07-31T00:00:00.000Z",
          imagePath: exe,
          imageSha256: exeSha256,
          imageBytes: 1024,
          imageFileId: "1234abcd:0x0123456789abcdef0123456789abcdef",
        },
        listener: { address: "127.0.0.1", port: 5759, owningPid: 4321 },
      },
    },
    assignments: [],
  };
}

function observationFixture(phase: "preflight-absent" | "installed" | "absent"): Record<string, unknown> {
  const installed = phase === "installed";
  return {
    schema: WINDOWS_DESKTOP_INTEGRATION_OBSERVATION_SCHEMA,
    phase,
    orchestrator: "native",
    observedAt: "2026-07-31T00:00:01.000Z",
    userNameSha256: "4".repeat(64),
    userSidSha256: "5".repeat(64),
    candidatePathSha256: "6".repeat(64),
    candidateSha256: exeSha256,
    candidateProcessId: 4321,
    nonAdmin: true,
    candidateOwnedTarget: true,
    candidateOwnerMatches: true,
    debugTokenInsideUserProfile: true,
    fileVerbInstalled: installed,
    directoryVerbInstalled: installed,
    sendToShortcutInstalled: installed,
    exactCandidateValues: installed,
    mutated: false,
  };
}

function source(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

function describeDriver(relativePath: string): ReleaseSurfaceDriverManifest {
  const result = spawnSync(process.execPath, ["--import", "tsx", resolve(root, relativePath), "--describe"], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim()) as ReleaseSurfaceDriverManifest;
}
