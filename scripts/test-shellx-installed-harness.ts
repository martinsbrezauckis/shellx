import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  HARNESS_SCHEMA,
  harnessGateEnvironment,
  validateHarnessState,
  type InstalledHarnessState,
} from "./shellx-installed-harness";
import { parseJsonValue } from "./runtime-json";

const state: InstalledHarnessState = {
  schemaVersion: HARNESS_SCHEMA,
  startedAt: "2026-07-10T00:00:00.000Z",
  pid: 1234,
  instanceId: "shellx-final-fixture01",
  candidateSourcePath: "C:\\build\\shellx.exe",
  executablePath: "C:\\Program Files\\shellX\\shellx.exe",
  executableVersion: "0.3.5",
  artifactSha256: "a".repeat(64),
  profilePath: "C:\\Temp\\shellx-final-webdriver-0123456789abcdef",
  shellxHome: "/mnt/c/Temp/shellx-final-webdriver-0123456789abcdef/.shellx",
  vaultProfilePath: "C:\\Temp\\shellx-final-webdriver-0123456789abcdef\\vault-e2e",
  vaultProfileDir: "/mnt/c/Temp/shellx-final-webdriver-0123456789abcdef/vault-e2e",
  debugBase: "http://127.0.0.1:30123",
  debugPort: 30123,
  mcpPort: 30124,
  appVersion: "0.3.5",
  buildCommit: "b".repeat(40),
};

assert.deepEqual(validateHarnessState(state), state);
const env = harnessGateEnvironment(state);
assert.equal(env.SHELLX_HOME, state.shellxHome);
assert.equal(env.SHELLX_DEBUG_BASE, state.debugBase);
assert.equal(env.SHELLX_DEBUG_PORT, "30123");
assert.equal(env.SHELLX_MCP_PORT, "30124");
assert.equal(env.SHELLX_VAULT_E2E, "1");
assert.equal(env.SHELLX_VAULT_PROFILE_DIR, state.vaultProfileDir);
assert.equal(Object.keys(env).some((key) => /token|secret/i.test(key)), false);

assert.throws(
  () => validateHarnessState({ ...state, artifactSha256: "short" }),
  /artifactSha256/,
);
assert.throws(
  () => validateHarnessState({ ...state, debugToken: "must-not-persist" }),
  /tokens or secrets/,
);
assert.throws(
  () => validateHarnessState({ ...state, pid: "1234" }),
  /pid must be an integer/,
);
assert.throws(
  () => parseJsonValue("{broken", "fixture receipt"),
  /fixture receipt is not valid JSON/,
);

const source = readFileSync(new URL("./shellx-installed-harness.ts", import.meta.url), "utf8");
assert.doesNotMatch(source, /Get-Process\s+shellx|Stop-Process\s+-Name|taskkill/i);
assert.doesNotMatch(source, /Get-CimInstance|Get-NetTCPConnection/);
assert.match(source, /PID image mismatch/);
assert.match(source, /SHELLX_INSTALLED_HARNESS_APP/);
assert.match(source, /Refusing to remove non-harness Windows profile/);
assert.match(source, /outside Windows TEMP/);
assert.match(source, /AddSeconds\(10\)/);
assert.match(source, /Start-Sleep -Milliseconds 250/);

const rust = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
assert.match(rust, /isolated_test_instance_requested/);
assert.match(rust, /shellx-final-webdriver-/);

console.log("ShellX installed harness tests passed");
