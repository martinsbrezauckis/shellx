import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  parseJsonValue,
  readJsonProperty,
  requireIntegerProperty,
  requireJsonObject,
  requireStringProperty,
} from "./runtime-json";

export const HARNESS_SCHEMA = "shellx.installed-harness.v3";

export type InstalledHarnessState = {
  schemaVersion: typeof HARNESS_SCHEMA;
  startedAt: string;
  pid: number;
  instanceId: string;
  candidateSourcePath: string;
  executablePath: string;
  executableVersion: string;
  artifactSha256: string;
  profilePath: string;
  shellxHome: string;
  vaultProfilePath: string;
  vaultProfileDir: string;
  debugBase: string;
  debugPort: number;
  mcpPort: number;
  appVersion: string;
  buildCommit: string;
};

type WindowsLaunchMetadata = {
  candidateSourcePath: string;
  executablePath: string;
  executableVersion: string;
  artifactSha256: string;
  profilePath: string;
  vaultProfilePath: string;
  debugPort: number;
  mcpPort: number;
  instanceId: string;
};

export function harnessGateEnvironment(state: InstalledHarnessState): NodeJS.ProcessEnv {
  const validated = validateHarnessState(state);
  return {
    SHELLX_HOME: validated.shellxHome,
    SHELLX_DEBUG_BASE: validated.debugBase,
    SHELLX_DEBUG_PORT: String(validated.debugPort),
    SHELLX_MCP_PORT: String(validated.mcpPort),
    SHELLX_VAULT_E2E: "1",
    SHELLX_VAULT_PROFILE_DIR: validated.vaultProfileDir,
  };
}

export function validateHarnessState(value: unknown): InstalledHarnessState {
  requireJsonObject(value, "Installed harness state");
  const serialized = JSON.stringify(value).toLowerCase();
  if (serialized.includes("token") || serialized.includes("secret")) {
    throw new Error("Installed harness receipts must not contain tokens or secrets");
  }
  const schemaVersion = requireStringProperty(value, "schemaVersion", "Installed harness state");
  if (schemaVersion !== HARNESS_SCHEMA) throw new Error(`Unexpected installed harness schema: ${schemaVersion}`);
  const pid = requireIntegerProperty(value, "pid", "Installed harness state");
  const debugPort = requireIntegerProperty(value, "debugPort", "Installed harness state");
  const mcpPort = requireIntegerProperty(value, "mcpPort", "Installed harness state");
  if (pid <= 0 || debugPort <= 0 || mcpPort <= 0) {
    throw new Error("Installed harness pid and ports must be positive");
  }
  const artifactSha256 = requireStringProperty(value, "artifactSha256", "Installed harness state");
  if (!/^[a-f0-9]{64}$/.test(artifactSha256)) throw new Error("Invalid installed harness artifactSha256");
  const instanceId = requireStringProperty(value, "instanceId", "Installed harness state");
  if (!/^[a-zA-Z0-9._-]{16,128}$/.test(instanceId)) throw new Error("Invalid installed harness instanceId");
  return {
    schemaVersion: HARNESS_SCHEMA,
    startedAt: requireStringProperty(value, "startedAt", "Installed harness state"),
    pid,
    instanceId,
    candidateSourcePath: requireStringProperty(value, "candidateSourcePath", "Installed harness state"),
    executablePath: requireStringProperty(value, "executablePath", "Installed harness state"),
    executableVersion: requireStringProperty(value, "executableVersion", "Installed harness state"),
    artifactSha256,
    profilePath: requireStringProperty(value, "profilePath", "Installed harness state"),
    shellxHome: requireStringProperty(value, "shellxHome", "Installed harness state"),
    vaultProfilePath: requireStringProperty(value, "vaultProfilePath", "Installed harness state"),
    vaultProfileDir: requireStringProperty(value, "vaultProfileDir", "Installed harness state"),
    debugBase: requireStringProperty(value, "debugBase", "Installed harness state"),
    debugPort,
    mcpPort,
    appVersion: requireStringProperty(value, "appVersion", "Installed harness state"),
    buildCommit: requireStringProperty(value, "buildCommit", "Installed harness state"),
  };
}

function powerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function runPowerShell(script: string, stage: string): string {
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || "PowerShell failed").trim();
    throw new Error(`${stage}: ${detail}`);
  }
  return result.stdout.trim();
}

function parsePowerShellJson(output: string): object {
  const line = output.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean).at(-1);
  if (!line) throw new Error("PowerShell returned no JSON");
  return requireJsonObject(parseJsonValue(line, "PowerShell output"), "PowerShell output");
}

function windowsToNodePath(path: string): string {
  if (process.platform === "win32") return path;
  const result = spawnSync("wslpath", ["-u", path], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Unable to map Windows path ${path}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function nodeToWindowsPath(path: string): string {
  if (process.platform === "win32" || /^[A-Za-z]:[\\/]/.test(path)) return path;
  const result = spawnSync("wslpath", ["-w", path], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Unable to map candidate path ${path}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function discoverWindowsLaunch(): WindowsLaunchMetadata {
  const suffix = randomBytes(8).toString("hex");
  const configuredExecutable = process.env.SHELLX_INSTALLED_HARNESS_APP?.trim();
  const configuredCandidate = configuredExecutable ? nodeToWindowsPath(configuredExecutable) : null;
  const candidateLines = configuredCandidate
    ? [`  ${powerShellLiteral(configuredCandidate)}`]
    : [
        "  (Join-Path $env:LOCALAPPDATA 'shellX\\shellx.exe'),",
        "  (Join-Path $env:LOCALAPPDATA 'shellx\\shellx.exe')",
      ];
  const parsed = parsePowerShellJson(runPowerShell([
    "$ErrorActionPreference = 'Stop'",
    "$candidates = @(",
    ...candidateLines,
    ")",
    "$exe = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1",
    "if (-not $exe) { throw 'ShellX candidate executable not found in the configured path or under LOCALAPPDATA' }",
    `$profile = Join-Path $env:TEMP ${powerShellLiteral(`shellx-final-webdriver-${suffix}`)}`,
    "try {",
    "$vault = Join-Path $profile 'vault-e2e'",
    "$localAppData = Join-Path $profile 'AppData\\Local'",
    "$roamingAppData = Join-Path $profile 'AppData\\Roaming'",
    "$temp = Join-Path $profile 'Temp'",
    "New-Item -ItemType Directory -Path $vault,$localAppData,$roamingAppData,$temp -Force | Out-Null",
    "$sourceItem = Get-Item -LiteralPath $exe",
    "$sourcePath = $sourceItem.FullName",
    ...(configuredCandidate ? [
      "$candidateDir = Join-Path $profile 'candidate'",
      "New-Item -ItemType Directory -Path $candidateDir -Force | Out-Null",
      "$stagedExe = Join-Path $candidateDir 'shellx.exe'",
      "Copy-Item -LiteralPath $sourcePath -Destination $stagedExe -Force",
      "$sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sourcePath).Hash.ToLowerInvariant()",
      "$stagedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $stagedExe).Hash.ToLowerInvariant()",
      "if ($sourceHash -ne $stagedHash) { throw 'Staged ShellX candidate hash does not match source' }",
      "$exe = $stagedExe",
    ] : []),
    "$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)",
    "$listener.Start(); $debugPort = ([Net.IPEndPoint]$listener.LocalEndpoint).Port; $listener.Stop()",
    "$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)",
    "$listener.Start(); $mcpPort = ([Net.IPEndPoint]$listener.LocalEndpoint).Port; $listener.Stop()",
    "$item = Get-Item -LiteralPath $exe",
    "$result = [pscustomobject]@{",
    "  candidateSourcePath = $sourcePath",
    "  executablePath = $item.FullName",
    "  executableVersion = $item.VersionInfo.ProductVersion",
    "  artifactSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $item.FullName).Hash.ToLowerInvariant()",
    "  profilePath = $profile",
    "  vaultProfilePath = $vault",
    "  debugPort = $debugPort",
    "  mcpPort = $mcpPort",
    "}",
    "$result | ConvertTo-Json -Compress",
    "} catch {",
    "  Remove-Item -LiteralPath $profile -Recurse -Force -ErrorAction SilentlyContinue",
    "  throw",
    "}",
  ].join("\n"), "discover Windows candidate"));
  const metadata: WindowsLaunchMetadata = {
    candidateSourcePath: requireStringProperty(parsed, "candidateSourcePath", "PowerShell launch metadata"),
    executablePath: requireStringProperty(parsed, "executablePath", "PowerShell launch metadata"),
    executableVersion: requireStringProperty(parsed, "executableVersion", "PowerShell launch metadata"),
    artifactSha256: requireStringProperty(parsed, "artifactSha256", "PowerShell launch metadata"),
    profilePath: requireStringProperty(parsed, "profilePath", "PowerShell launch metadata"),
    vaultProfilePath: requireStringProperty(parsed, "vaultProfilePath", "PowerShell launch metadata"),
    debugPort: requireIntegerProperty(parsed, "debugPort", "PowerShell launch metadata"),
    mcpPort: requireIntegerProperty(parsed, "mcpPort", "PowerShell launch metadata"),
    instanceId: `shellx-final-${suffix}`,
  };
  if (!/^[a-f0-9]{64}$/.test(metadata.artifactSha256)) {
    throw new Error("PowerShell launch metadata artifactSha256 is invalid");
  }
  return metadata;
}

function startWindowsProcess(metadata: WindowsLaunchMetadata): number {
  const result = parsePowerShellJson(runPowerShell([
    "$ErrorActionPreference = 'Stop'",
    `$marker = [ordered]@{ schema = 'shellx/release-surface-run-profile@1'; platform = 'windows-installed'; runId = ${powerShellLiteral(metadata.instanceId.replace(/^shellx-final-/, ""))}; nodePath = ${powerShellLiteral(metadata.profilePath)}; launchPath = ${powerShellLiteral(metadata.profilePath)} }`,
    "$markerJson = $marker | ConvertTo-Json -Compress",
    `$markerPath = Join-Path ${powerShellLiteral(metadata.profilePath)} 'shellx-final-profile.json'`,
    "[IO.File]::WriteAllText($markerPath, $markerJson, (New-Object Text.UTF8Encoding($false)))",
    `$env:HOME = ${powerShellLiteral(metadata.profilePath)}`,
    `$env:USERPROFILE = ${powerShellLiteral(metadata.profilePath)}`,
    `$env:LOCALAPPDATA = Join-Path ${powerShellLiteral(metadata.profilePath)} 'AppData\\Local'`,
    `$env:APPDATA = Join-Path ${powerShellLiteral(metadata.profilePath)} 'AppData\\Roaming'`,
    `$env:TEMP = Join-Path ${powerShellLiteral(metadata.profilePath)} 'Temp'`,
    `$env:TMP = $env:TEMP`,
    "$env:SHELLX_TEST_INSTANCE = '1'",
    `$env:SHELLX_TEST_INSTANCE_ID = ${powerShellLiteral(metadata.instanceId)}`,
    "$env:SHELLX_MIGRATE_DATA_DIR = '0'",
    `$env:SHELLX_DEBUG_PORT = ${powerShellLiteral(String(metadata.debugPort))}`,
    `$env:SHELLX_MCP_PORT = ${powerShellLiteral(String(metadata.mcpPort))}`,
    "$env:SHELLX_VAULT_E2E = '1'",
    `$env:SHELLX_VAULT_PROFILE_DIR = ${powerShellLiteral(metadata.vaultProfilePath)}`,
    `$process = Start-Process -FilePath ${powerShellLiteral(metadata.executablePath)} -PassThru`,
    "[pscustomobject]@{ pid = $process.Id } | ConvertTo-Json -Compress",
  ].join("\n"), "launch isolated Windows candidate"));
  const pid = requireIntegerProperty(result, "pid", "PowerShell process result");
  if (pid <= 0) throw new Error("Installed ShellX launch did not return a PID");
  return pid;
}

async function waitForOwnedDebugApi(
  metadata: WindowsLaunchMetadata,
  pid: number,
  shellxHome: string,
  timeoutMs = 30_000,
): Promise<{ appVersion: string; buildCommit: string; base: string }> {
  const portFile = `${shellxHome}/debug-api.port`;
  const tokenFile = `${shellxHome}/shellxagent.token`;
  const deadline = Date.now() + timeoutMs;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    try {
      ensureOwnedWindowsProcess(pid, metadata.executablePath);
      if (!existsSync(portFile) || !existsSync(tokenFile)) throw new Error("paired port/token files are not ready");
      const port = Number(readFileSync(portFile, "utf8").trim());
      const token = readFileSync(tokenFile, "utf8").trim();
      if (!Number.isInteger(port) || port <= 0 || token.length < 32) throw new Error("paired port/token files are invalid");
      const base = `http://127.0.0.1:${port}`;
      const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1_500) });
      if (!health.ok) throw new Error(`/health returned ${health.status}`);
      const healthBody = await health.json();
      const healthOk = readJsonProperty(healthBody, "ok", "ShellX health response");
      const healthPort = readJsonProperty(healthBody, "debugApiPort", "ShellX health response");
      const appVersion = readJsonProperty(healthBody, "appVersion", "ShellX health response");
      const processId = readJsonProperty(healthBody, "processId", "ShellX health response");
      const instanceId = readJsonProperty(healthBody, "instanceId", "ShellX health response");
      const buildCommit = readJsonProperty(healthBody, "buildCommit", "ShellX health response");
      if (healthOk !== true || healthPort !== port || processId !== pid || instanceId !== metadata.instanceId
        || typeof appVersion !== "string" || !appVersion.trim()
        || typeof buildCommit !== "string" || !buildCommit.trim()) {
        throw new Error("/health does not match the owned port file");
      }
      const state = await fetch(`${base}/browser/state`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2_000),
      });
      if (!state.ok) throw new Error(`/browser/state returned ${state.status}`);
      return { appVersion, buildCommit, base };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Owned installed ShellX did not become ready within ${timeoutMs}ms: ${lastError}`);
}

function ensureOwnedWindowsProcess(pid: number, executablePath: string): void {
  runPowerShell([
    `$process = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    "if (-not $process) { throw 'Owned ShellX process is not running' }",
    `$expected = [IO.Path]::GetFullPath(${powerShellLiteral(executablePath)})`,
    "$actual = [IO.Path]::GetFullPath($process.Path)",
    "if (-not $actual.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) { throw \"PID image mismatch: $actual\" }",
  ].join("\n"), "verify owned Windows candidate");
}

function stopOwnedWindowsProcess(pid: number, executablePath: string): void {
  runPowerShell([
    `$process = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    "if (-not $process) { exit 0 }",
    `$expected = [IO.Path]::GetFullPath(${powerShellLiteral(executablePath)})`,
    "$actual = [IO.Path]::GetFullPath($process.Path)",
    "if (-not $actual.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) { throw \"Refusing to stop PID image mismatch: $actual\" }",
    `Stop-Process -Id ${pid} -Force`,
    `Wait-Process -Id ${pid} -Timeout 10 -ErrorAction SilentlyContinue`,
  ].join("\n"), "stop owned Windows candidate");
}

function removeWindowsProfile(profilePath: string): void {
  const profileName = profilePath.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) ?? "";
  if (!/^shellx-final-webdriver-[a-f0-9]{16}$/.test(profileName)) {
    throw new Error(`Refusing to remove non-harness Windows profile: ${profilePath}`);
  }
  runPowerShell([
    `$profile = [IO.Path]::GetFullPath(${powerShellLiteral(profilePath)})`,
    "$tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar",
    "if (-not $profile.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing to remove harness profile outside Windows TEMP' }",
    "$deadline = [DateTime]::UtcNow.AddSeconds(10)",
    "do {",
    "  Remove-Item -LiteralPath $profile -Recurse -Force -ErrorAction SilentlyContinue",
    "  if (-not (Test-Path -LiteralPath $profile)) { break }",
    "  Start-Sleep -Milliseconds 250",
    "} while ([DateTime]::UtcNow -lt $deadline)",
    "if (Test-Path -LiteralPath $profile) { throw 'Disposable ShellX profile still exists after bounded cleanup retries' }",
  ].join("\n"), "remove isolated Windows profile");
}

function semverPrefix(version: string): string | null {
  return version.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? null;
}

async function startHarness(statePath: string): Promise<InstalledHarnessState> {
  if (existsSync(statePath)) throw new Error(`Installed harness state already exists: ${statePath}`);
  const metadata = discoverWindowsLaunch();
  const shellxHome = `${windowsToNodePath(metadata.profilePath)}/.shellx`;
  const vaultProfileDir = windowsToNodePath(metadata.vaultProfilePath);
  let pid: number | null = null;
  try {
    pid = startWindowsProcess(metadata);
    const ready = await waitForOwnedDebugApi(metadata, pid, shellxHome);
    if (!semverPrefix(metadata.executableVersion) || semverPrefix(metadata.executableVersion) !== semverPrefix(ready.appVersion)) {
      throw new Error(`Installed executable version ${metadata.executableVersion} disagrees with /health ${ready.appVersion}`);
    }
    const state = validateHarnessState({
      schemaVersion: HARNESS_SCHEMA,
      startedAt: new Date().toISOString(),
      pid,
      instanceId: metadata.instanceId,
      candidateSourcePath: metadata.candidateSourcePath,
      executablePath: metadata.executablePath,
      executableVersion: metadata.executableVersion,
      artifactSha256: metadata.artifactSha256,
      profilePath: metadata.profilePath,
      shellxHome,
      vaultProfilePath: metadata.vaultProfilePath,
      vaultProfileDir,
      debugBase: ready.base,
      debugPort: Number(new URL(ready.base).port),
      mcpPort: metadata.mcpPort,
      appVersion: ready.appVersion,
      buildCommit: ready.buildCommit,
    });
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return state;
  } catch (error) {
    if (pid) {
      try { stopOwnedWindowsProcess(pid, metadata.executablePath); } catch { /* preserve the launch error */ }
    }
    try { removeWindowsProfile(metadata.profilePath); } catch { /* preserve the launch error */ }
    throw error;
  }
}

function readHarnessState(statePath: string): InstalledHarnessState {
  const state = parseJsonValue(readFileSync(statePath, "utf8"), "Installed harness state file");
  return validateHarnessState(state);
}

function stopHarness(statePath: string): { stoppedPid: number; removedProfile: string } {
  const state = readHarnessState(statePath);
  stopOwnedWindowsProcess(state.pid, state.executablePath);
  removeWindowsProfile(state.profilePath);
  rmSync(statePath, { force: true });
  return { stoppedPid: state.pid, removedProfile: state.profilePath };
}

function readArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const prefix = `${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.find((arg) => !arg.startsWith("-"));
  const statePath = readArg(args, "--state");
  if (!statePath || !["start", "stop", "status", "env"].includes(command || "")) {
    throw new Error("Usage: pnpm run shellx:installed-harness -- <start|stop|status|env> --state <path>");
  }
  if (command === "start") console.log(JSON.stringify(await startHarness(statePath)));
  if (command === "stop") console.log(JSON.stringify(stopHarness(statePath)));
  if (command === "status") console.log(JSON.stringify(readHarnessState(statePath)));
  if (command === "env") console.log(JSON.stringify(harnessGateEnvironment(readHarnessState(statePath))));
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  main().catch((error) => {
    console.error(`FAIL installed ShellX harness: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
