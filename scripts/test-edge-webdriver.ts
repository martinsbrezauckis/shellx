import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  edgeDriverCachePath,
  edgeDriverDownloadUrl,
  edgeDriverIsCompatible,
  ensureEdgeDriver,
  installedMicrosoftEdgeVersion,
  parseFourPartVersion,
  type EdgeDriverDependencies,
} from "./edge-webdriver";

let passed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

console.log("\n=== Edge WebDriver preflight tests ===");

test("parses versions from Edge and WebDriver output", () => {
  assert.equal(parseFourPartVersion("MSEdgeDriver 150.0.4078.38 (abc)", "driver"), "150.0.4078.38");
});

test("accepts Microsoft-compatible fourth-component differences", () => {
  assert.equal(edgeDriverIsCompatible("150.0.4078.48", "150.0.4078.38"), true);
  assert.equal(edgeDriverIsCompatible("150.0.4078.48", "150.0.4077.99"), false);
});

test("builds the exact-version official download and cache paths", () => {
  assert.equal(
    edgeDriverDownloadUrl("150.0.4078.48"),
    "https://msedgedriver.microsoft.com/150.0.4078.48/edgedriver_win64.zip",
  );
  assert.equal(
    edgeDriverCachePath("C:\\Users\\FixtureUser", "150.0.4078.48"),
    "C:\\Users\\FixtureUser\\.shellx\\tools\\msedgedriver\\150.0.4078.48\\win64\\msedgedriver.exe",
  );
});

test("uses and verifies a compatible cached driver without acquisition", () => {
  let installs = 0;
  const dependencies = fakeDependencies({
    existing: new Set(["cached.exe"]),
    versions: new Map([["cached.exe", "MSEdgeDriver 150.0.4078.38"]]),
    install: () => { installs += 1; },
  });
  const resolution = ensureEdgeDriver({
    autoInstall: true,
    browserVersion: "150.0.4078.48",
    cachePath: "cached.exe",
    dependencies,
  });
  assert.equal(resolution.source, "cache");
  assert.equal(resolution.driverVersion, "150.0.4078.38");
  assert.equal(installs, 0);
});

test("acquires the exact browser version when the cache is missing", () => {
  const existing = new Set<string>();
  const versions = new Map<string, string>();
  let requestedUrl = "";
  const dependencies = fakeDependencies({
    existing,
    versions,
    install: ({ browserVersion, downloadUrl, targetPath }) => {
      assert.equal(browserVersion, "150.0.4078.48");
      requestedUrl = downloadUrl;
      existing.add(targetPath);
      versions.set(targetPath, "MSEdgeDriver 150.0.4078.48");
    },
  });
  const resolution = ensureEdgeDriver({
    autoInstall: true,
    browserVersion: "150.0.4078.48",
    cachePath: "cached.exe",
    dependencies,
  });
  assert.equal(resolution.source, "download");
  assert.equal(requestedUrl, edgeDriverDownloadUrl("150.0.4078.48"));
});

test("replaces an incompatible cache only when acquisition is enabled", () => {
  const existing = new Set(["cached.exe"]);
  const versions = new Map([["cached.exe", "MSEdgeDriver 149.0.4022.69"]]);
  const dependencies = fakeDependencies({
    existing,
    versions,
    install: ({ targetPath }) => versions.set(targetPath, "MSEdgeDriver 150.0.4078.48"),
  });
  assert.throws(
    () => ensureEdgeDriver({
      autoInstall: false,
      browserVersion: "150.0.4078.48",
      cachePath: "cached.exe",
      dependencies,
    }),
    /incompatible with WebDriver 149\.0\.4022\.69/,
  );
  assert.equal(ensureEdgeDriver({
    autoInstall: true,
    browserVersion: "150.0.4078.48",
    cachePath: "cached.exe",
    dependencies,
  }).source, "download");
});

test("rejects a configured mismatch before any acquisition", () => {
  let installs = 0;
  const dependencies = fakeDependencies({
    existing: new Set(["configured.exe"]),
    versions: new Map([["configured.exe", "MSEdgeDriver 149.0.4022.69"]]),
    install: () => { installs += 1; },
  });
  assert.throws(
    () => ensureEdgeDriver({
      autoInstall: true,
      browserVersion: "150.0.4078.48",
      cachePath: "cached.exe",
      configuredPath: "configured.exe",
      dependencies,
    }),
    /first three version components must match/,
  );
  assert.equal(installs, 0);
});

test("the final candidate runner binds the configured driver to installed Edge", () => {
  const runner = readFileSync(new URL("./run-release-surface-webdriver-candidate.ts", import.meta.url), "utf8");
  assert.match(runner, /installedMicrosoftEdgeVersion\(\)/);
  assert.match(runner, /ensureEdgeDriver\(\{/);
  assert.match(runner, /autoInstall: false/);
  assert.match(runner, /configuredPath: nativeDriverLaunchPath!/);
  assert.equal(typeof installedMicrosoftEdgeVersion, "function");
});

test("fails clearly when acquisition is disabled and no cache exists", () => {
  const dependencies = fakeDependencies({ existing: new Set(), versions: new Map() });
  assert.throws(
    () => ensureEdgeDriver({
      autoInstall: false,
      browserVersion: "150.0.4078.48",
      cachePath: "cached.exe",
      dependencies,
    }),
    /SHELLX_WEBDRIVER_AUTO_INSTALL=1/,
  );
});

test("the installed-app smoke stages and cleans only its exact candidate", () => {
  const smoke = readFileSync(new URL("./test-tauri-webdriver.ts", import.meta.url), "utf8");
  assert.match(smoke, /Staged ShellX WebDriver candidate hash mismatch/);
  assert.match(smoke, /SHELLX_INSTALLED_HARNESS_APP/);
  assert.match(smoke, /applicationSha256/);
  assert.match(smoke, /netstat\.exe/);
  assert.match(smoke, /Stop-Process -Id \$process\.Id/);
  assert.doesNotMatch(smoke, /Get-CimInstance|Get-NetTCPConnection/);
  assert.match(smoke, /shellx\.tauri-webdriver\.v1/);
  assert.match(smoke, /env\.WSLENV/);
  assert.match(smoke, /isolatedProfileVerified/);
  assert.match(smoke, /applicationProcessCountAfter/);
  assert.match(smoke, /nativeDriverProcessCountAfter/);
  assert.match(smoke, /status: "pass"/);
  assert.match(smoke, /WebDriver and native driver ports must be distinct/);
  assert.match(smoke, /driverSpawnErrors\.get\(child\)/);
  assert.match(smoke, /rendered UI excludes the stable user ShellX history path/);
  assert.doesNotMatch(smoke, /C:\\\\Users\\\\User/);
  assert.doesNotMatch(smoke, /Stop-Process\s+-Name|taskkill\s+\/IM|close-existing/i);
});

test("the optional Vault gate uses a trusted WebDriver click and redacted disposable profile", () => {
  const smoke = readFileSync(new URL("./test-tauri-webdriver.ts", import.meta.url), "utf8");
  const vaultGate = readFileSync(
    new URL("./tauri-webdriver-vault-agent-request.ts", import.meta.url),
    "utf8",
  );
  assert.match(smoke, /--vault-agent-request/);
  assert.match(smoke, /runVaultAgentRequestWebdriverGate/);
  assert.match(smoke, /readFileSync\(config\.application\)/);
  assert.match(vaultGate, /SHELLX_VAULT_E2E/);
  assert.match(vaultGate, /SHELLX_VAULT_PROFILE_DIR/);
  assert.match(vaultGate, /buildCommit/);
  assert.match(vaultGate, /vault-request-action-approveVaultAgentRequest/);
  assert.match(vaultGate, /\/element\/\$\{encodeURIComponent\(id\)\}\/click/);
  assert.match(vaultGate, /\[REDACTED BY VAULT\]/);
  assert.match(vaultGate, /\/vault\/e2e\/reset/);
  assert.match(vaultGate, /\/vault\/delete/);
  assert.doesNotMatch(vaultGate, /shellx_vault_agent_request_approve/);
});

console.log(`PASS Edge WebDriver preflight tests (${passed})`);

function fakeDependencies(input: {
  existing: Set<string>;
  versions: Map<string, string>;
  install?: EdgeDriverDependencies["install"];
}): EdgeDriverDependencies {
  return {
    exists: (path) => input.existing.has(path),
    readVersion: (path) => input.versions.get(path) ?? "",
    install: input.install ?? (() => { throw new Error("unexpected install"); }),
  };
}
