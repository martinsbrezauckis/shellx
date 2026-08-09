import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

import { edgeDriverCachePath, ensureEdgeDriver } from "./edge-webdriver";
import {
  runVaultAgentRequestWebdriverGate,
  type VaultAgentRequestEvidence,
} from "./tauri-webdriver-vault-agent-request";
import {
  optionalStringProperty,
  parseJsonValue,
  readJsonProperty,
  requireBooleanProperty,
  requireIntegerProperty,
  requireJsonObject,
  requireStringProperty,
} from "./runtime-json";

type WebDriverJson = {
  value?: unknown;
  sessionId?: string;
};

type Platform = "linux" | "windows";

type DriverConfig = {
  kind: "linux";
  tauriDriver: string;
  application: string;
  nativeDriver?: string;
};

type WindowsDriverConfig = {
  kind: "windows";
  tauriDriver: string;
  application: string;
  nativeDriver: string;
  edgeVersion: string;
  nativeDriverVersion: string;
  nativeDriverSource: string;
  applicationSource: string;
  applicationSha256: string;
  applicationVersion: string;
  profilePath: string;
  hostUserProfile: string;
  debugPort: number;
  mcpPort: number;
};

type AnyDriverConfig = DriverConfig | WindowsDriverConfig;

type WindowsCleanupEvidence = {
  applicationProcessesStopped: number;
  nativeDriverProcessesStopped: number;
  applicationProcessCountAfter: number;
  nativeDriverProcessCountAfter: number;
  profileExistsAfter: boolean;
};

type SmokeEvidence = {
  screenshotBytes: number;
  screenshotSha256: string;
};

const args = new Set(process.argv.slice(2));
const platform = resolvePlatform();
const allocatedPorts = new Set<number>();
const port = Number(process.env.SHELLX_WEBDRIVER_PORT || randomPort());
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid SHELLX_WEBDRIVER_PORT");
allocatedPorts.add(port);
const nativePort = Number(process.env.SHELLX_WEBDRIVER_NATIVE_PORT || randomPort());
if (!Number.isInteger(nativePort) || nativePort < 1 || nativePort > 65_535) {
  throw new Error("Invalid SHELLX_WEBDRIVER_NATIVE_PORT");
}
if (nativePort === port) throw new Error("WebDriver and native driver ports must be distinct");
allocatedPorts.add(nativePort);
const driverUrl = `http://127.0.0.1:${port}`;
const evidenceDir = process.env.SHELLX_WEBDRIVER_EVIDENCE_DIR?.trim()
  || mkdtempSync(join(tmpdir(), "shellx-tauri-webdriver-"));
const screenshotPath = join(evidenceDir, `shellx-webdriver-${platform}.png`);
const driverSpawnErrors = new WeakMap<ChildProcess, Error>();
mkdirSync(evidenceDir, { recursive: true });

function assert(condition: unknown, label: string): void {
  if (!condition) throw new Error(label);
  console.log(`  ✓ ${label}`);
}

function resolvePlatform(): Platform {
  const value = (process.env.SHELLX_WEBDRIVER_PLATFORM || "").trim().toLowerCase();
  if (value === "windows" || args.has("--windows")) return "windows";
  if (value === "linux" || args.has("--linux")) return "linux";
  return process.platform === "win32" ? "windows" : "linux";
}

function run(command: string, commandArgs: string[]): string {
  const result = spawnSync(command, commandArgs, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function maybeRun(command: string, commandArgs: string[]): string | null {
  const result = spawnSync(command, commandArgs, { encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function commandExists(command: string): boolean {
  if (process.platform === "win32") {
    return spawnSync("where.exe", [command]).status === 0;
  }
  return spawnSync("bash", ["-lc", `command -v ${JSON.stringify(command)} >/dev/null 2>&1`]).status === 0;
}

function randomPort(): number {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = 20_000 + Math.floor(Math.random() * 20_000);
    if (!allocatedPorts.has(candidate)) {
      allocatedPorts.add(candidate);
      return candidate;
    }
  }
  throw new Error("Unable to allocate a distinct WebDriver test port");
}

function winJoin(...parts: string[]): string {
  const [first, ...rest] = parts;
  return [first, ...rest]
    .filter(Boolean)
    .join("\\")
    .replace(/[\\/]+/g, "\\");
}

function powerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function windowsEnv(name: string): string {
  const direct = process.env[name]?.trim();
  if (direct && process.platform === "win32") return direct;
  const fromPowerShell = maybeRun("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Write-Output $env:${name}`,
  ]);
  if (!fromPowerShell) throw new Error(`Unable to resolve Windows %${name}%`);
  return fromPowerShell.replace(/\r?\n/g, "").trim();
}

function windowsPathExists(path: string): boolean {
  if (process.platform === "win32") return existsSync(path);
  const escaped = path.replace(/'/g, "''");
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `if (Test-Path '${escaped}') { exit 0 } else { exit 1 }`,
  ]);
  return result.status === 0;
}

function windowsToWslPath(path: string): string {
  if (process.platform === "win32") return path;
  return run("wslpath", ["-u", path]);
}

function windowsInputPath(path: string): string {
  if (process.platform === "win32" || !path.startsWith("/")) return path;
  return run("wslpath", ["-w", path]).replace(/\r?\n/g, "").trim();
}

function chooseExistingWindowsPath(candidates: string[]): string {
  const found = candidates.find(windowsPathExists);
  if (!found) throw new Error(`None of the Windows path candidates exist: ${candidates.join("; ")}`);
  return found;
}

function stageWindowsApplication(sourcePath: string): {
  sourcePath: string;
  application: string;
  applicationSha256: string;
  applicationVersion: string;
  profilePath: string;
} {
  const source = windowsInputPath(sourcePath);
  const runId = randomUUID().replace(/-/g, "").slice(0, 16);
  const rootName = `shellx-final-webdriver-${runId}`;
  const output = run("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    [
      "$ErrorActionPreference = 'Stop'",
      "$root = $null",
      "try {",
      `$source = ${powerShellLiteral(source)}`,
      `if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'ShellX WebDriver source candidate not found' }`,
      `$root = Join-Path $env:TEMP ${powerShellLiteral(rootName)}`,
      "$candidateDir = Join-Path $root 'candidate'",
      "$application = Join-Path $candidateDir 'shellx.exe'",
      "New-Item -ItemType Directory -Path $candidateDir -Force | Out-Null",
      "New-Item -ItemType Directory -Path (Join-Path $root 'AppData\\Local') -Force | Out-Null",
      "New-Item -ItemType Directory -Path (Join-Path $root 'AppData\\Roaming') -Force | Out-Null",
      `$marker = [ordered]@{ schema = 'shellx/release-surface-run-profile@1'; platform = 'windows-installed'; runId = ${powerShellLiteral(runId)}; nodePath = $root; launchPath = $root }`,
      "$markerJson = $marker | ConvertTo-Json -Compress",
      "$markerPath = Join-Path $root 'shellx-final-profile.json'",
      "[IO.File]::WriteAllText($markerPath, $markerJson, (New-Object Text.UTF8Encoding($false)))",
      "Copy-Item -LiteralPath $source -Destination $application -Force",
      "$sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash.ToLowerInvariant()",
      "$stagedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $application).Hash.ToLowerInvariant()",
      "if ($sourceHash -ne $stagedHash) { throw 'Staged ShellX WebDriver candidate hash mismatch' }",
      "$item = Get-Item -LiteralPath $application",
      "[pscustomobject]@{ sourcePath = $source; application = $application; applicationSha256 = $stagedHash; applicationVersion = $item.VersionInfo.ProductVersion; profilePath = $root } | ConvertTo-Json -Compress",
      "} catch {",
      "if ($root -and (Test-Path -LiteralPath $root)) { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }",
      "throw",
      "}",
    ].join("; "),
  ]);
  const parsed = requireJsonObject(parseJsonValue(output, "PowerShell candidate staging output"), "PowerShell candidate staging output");
  const applicationSha256 = requireStringProperty(parsed, "applicationSha256", "PowerShell candidate staging output");
  if (!/^[a-f0-9]{64}$/.test(applicationSha256)) throw new Error("PowerShell candidate staging SHA-256 is invalid");
  return {
    sourcePath: requireStringProperty(parsed, "sourcePath", "PowerShell candidate staging output"),
    application: requireStringProperty(parsed, "application", "PowerShell candidate staging output"),
    applicationSha256,
    applicationVersion: requireStringProperty(parsed, "applicationVersion", "PowerShell candidate staging output"),
    profilePath: requireStringProperty(parsed, "profilePath", "PowerShell candidate staging output"),
  };
}

function cleanupWindowsApplication(config: WindowsDriverConfig): WindowsCleanupEvidence {
  const output = run("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    [
      "$ErrorActionPreference = 'Stop'",
      `$expected = [IO.Path]::GetFullPath(${powerShellLiteral(config.application)})`,
      `$nativeDriver = [IO.Path]::GetFullPath(${powerShellLiteral(config.nativeDriver)})`,
      `$nativePort = ${nativePort}`,
      "function Get-LoopbackListenerOwnerIds([int]$Port) {",
      "  $output = & \"$env:SystemRoot\\System32\\netstat.exe\" -ano -p tcp",
      "  if ($LASTEXITCODE -ne 0) { throw 'unable to inspect Windows loopback listeners' }",
      "  $owners = [Collections.Generic.List[int]]::new()",
      "  foreach ($line in $output) {",
      "    $parts = @($line.Trim() -split '\\s+')",
      "    if ($parts.Count -ne 5 -or $parts[0] -cne 'TCP') { continue }",
      "    if ($parts[1] -cne \"127.0.0.1:$Port\" -or $parts[2] -cne '0.0.0.0:0') { continue }",
      "    $owner = 0",
      "    if (-not [int]::TryParse($parts[4], [ref]$owner) -or $owner -le 0) { throw 'Windows loopback listener owner is invalid' }",
      "    $owners.Add($owner)",
      "  }",
      "  return @($owners | Sort-Object -Unique)",
      "}",
      "$owned = @(Get-Process -Name 'shellx','app' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and [IO.Path]::GetFullPath($_.Path) -ieq $expected })",
      "$ownedDriver = @()",
      "foreach ($ownerPid in @(Get-LoopbackListenerOwnerIds $nativePort)) {",
      "  $driverProcess = Get-Process -Id $ownerPid -ErrorAction Stop",
      "  if (-not $driverProcess.Path -or [IO.Path]::GetFullPath($driverProcess.Path) -ine $nativeDriver) { throw 'Edge WebDriver listener owner image mismatch' }",
      "  $ownedDriver += $driverProcess",
      "}",
      "foreach ($process in $owned) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }",
      "foreach ($process in $ownedDriver) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }",
      "if (($owned.Count + $ownedDriver.Count) -gt 0) { Start-Sleep -Milliseconds 500 }",
      "$remaining = @(Get-Process -Name 'shellx','app' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and [IO.Path]::GetFullPath($_.Path) -ieq $expected })",
      "$remainingDriver = @(Get-LoopbackListenerOwnerIds $nativePort)",
      "if ($remaining.Count -gt 0) { throw 'Owned ShellX WebDriver process did not stop' }",
      "if ($remainingDriver.Count -gt 0) { throw 'Owned Edge WebDriver process did not stop' }",
      `Remove-Item -LiteralPath ${powerShellLiteral(config.profilePath)} -Recurse -Force`,
      `if (Test-Path -LiteralPath ${powerShellLiteral(config.profilePath)}) { throw 'ShellX WebDriver profile cleanup failed' }`,
      "[pscustomobject]@{ applicationProcessesStopped = $owned.Count; nativeDriverProcessesStopped = $ownedDriver.Count; applicationProcessCountAfter = $remaining.Count; nativeDriverProcessCountAfter = $remainingDriver.Count; profileExistsAfter = $false } | ConvertTo-Json -Compress",
    ].join("; "),
  ]);
  const parsed = requireJsonObject(parseJsonValue(output, "PowerShell cleanup output"), "PowerShell cleanup output");
  return {
    applicationProcessesStopped: requireIntegerProperty(parsed, "applicationProcessesStopped", "PowerShell cleanup output"),
    nativeDriverProcessesStopped: requireIntegerProperty(parsed, "nativeDriverProcessesStopped", "PowerShell cleanup output"),
    applicationProcessCountAfter: requireIntegerProperty(parsed, "applicationProcessCountAfter", "PowerShell cleanup output"),
    nativeDriverProcessCountAfter: requireIntegerProperty(parsed, "nativeDriverProcessCountAfter", "PowerShell cleanup output"),
    profileExistsAfter: requireBooleanProperty(parsed, "profileExistsAfter", "PowerShell cleanup output"),
  };
}

function resolveLinuxConfig(): DriverConfig {
  const tauriDriver = process.env.SHELLX_WEBDRIVER_TAURI_DRIVER?.trim()
    || join(process.env.HOME || "", ".cargo", "bin", "tauri-driver");
  const application = process.env.SHELLX_WEBDRIVER_APP?.trim()
    || resolve("src-tauri", "target", "release", "shellx");
  const nativeDriver = process.env.SHELLX_WEBDRIVER_NATIVE_DRIVER?.trim() || undefined;
  return { kind: "linux", tauriDriver, application, nativeDriver };
}

function resolveWindowsConfig(): WindowsDriverConfig {
  const userProfile = windowsEnv("USERPROFILE");
  const localAppData = windowsEnv("LOCALAPPDATA");
  const edgeVersion = process.env.SHELLX_WEBDRIVER_EDGE_VERSION?.trim()
    || maybeRun("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "$v=(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Edge\\BLBeacon' -ErrorAction SilentlyContinue).version; if (-not $v) { $v=(Get-ItemProperty 'HKLM:\\Software\\Microsoft\\Edge\\BLBeacon' -ErrorAction SilentlyContinue).version }; Write-Output $v",
    ])?.replace(/\r?\n/g, "").trim();
  if (!edgeVersion) throw new Error("Unable to resolve Microsoft Edge version for msedgedriver path");

  const tauriDriverWin = process.env.SHELLX_WEBDRIVER_TAURI_DRIVER?.trim()
    || chooseExistingWindowsPath([
      winJoin(userProfile, ".cargo", "bin", "tauri-driver.exe"),
    ]);
  const nativeDriver = ensureEdgeDriver({
    autoInstall: process.env.SHELLX_WEBDRIVER_AUTO_INSTALL !== "0",
    browserVersion: edgeVersion,
    cachePath: edgeDriverCachePath(userProfile, edgeVersion),
    configuredPath: process.env.SHELLX_WEBDRIVER_NATIVE_DRIVER?.trim(),
  });
  const applicationSource = process.env.SHELLX_WEBDRIVER_APP?.trim()
    || process.env.SHELLX_INSTALLED_HARNESS_APP?.trim()
    || chooseExistingWindowsPath([
      winJoin(localAppData, "shellX", "shellx.exe"),
      winJoin(localAppData, "shellx", "shellx.exe"),
    ]);
  const tauriDriver = process.platform === "win32" ? tauriDriverWin : windowsToWslPath(tauriDriverWin);
  const candidate = stageWindowsApplication(applicationSource);
  return {
    kind: "windows",
    tauriDriver,
    nativeDriver: nativeDriver.path,
    application: candidate.application,
    edgeVersion: nativeDriver.browserVersion,
    nativeDriverVersion: nativeDriver.driverVersion,
    nativeDriverSource: nativeDriver.source,
    applicationSource: candidate.sourcePath,
    applicationSha256: candidate.applicationSha256,
    applicationVersion: candidate.applicationVersion,
    profilePath: candidate.profilePath,
    hostUserProfile: userProfile,
    debugPort: randomPort(),
    mcpPort: randomPort(),
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function webdriverRequest(method: string, path: string, body?: unknown): Promise<WebDriverJson> {
  const res = await fetch(`${driverUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} failed ${res.status}: ${text.slice(0, 2000)}`);
  if (!text) return {};
  const parsed = requireJsonObject(parseJsonValue(text, `WebDriver ${method} ${path} response`), `WebDriver ${method} ${path} response`);
  return {
    value: readJsonProperty(parsed, "value", `WebDriver ${method} ${path} response`),
    sessionId: optionalStringProperty(parsed, "sessionId", `WebDriver ${method} ${path} response`),
  };
}

async function waitForDriver(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const spawnError = driverSpawnErrors.get(child);
    if (spawnError) throw new Error(`tauri-driver failed to start: ${spawnError.message}`);
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`tauri-driver exited before becoming ready (exit=${child.exitCode}, signal=${child.signalCode})`);
    }
    try {
      const status = await webdriverRequest("GET", "/status");
      if (status.value) return;
    } catch {
      // The native driver may take a moment to bind.
    }
    await sleep(250);
  }
  throw new Error(`tauri-driver did not become ready on ${driverUrl}`);
}

async function quitSession(sessionId: string): Promise<void> {
  try {
    await webdriverRequest("DELETE", `/session/${sessionId}`);
  } catch (err) {
    console.warn(`  ! session cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function stopDriver(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    sleep(2_000),
  ]);
  if (child.exitCode !== null || child.signalCode !== null) return;
  const killed = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  child.kill("SIGKILL");
  await Promise.race([
    killed,
    sleep(2_000),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error("Owned tauri-driver process did not stop");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function launchDriver(config: AnyDriverConfig): ChildProcess {
  const driverArgs = ["--port", String(port), "--native-port", String(nativePort)];
  if (config.nativeDriver) driverArgs.push("--native-driver", config.nativeDriver);
  const env = { ...process.env };
  if (config.kind === "windows") {
    const bridgedVariables = [
      "HOME",
      "USERPROFILE",
      "LOCALAPPDATA",
      "APPDATA",
      "SHELLX_TEST_INSTANCE",
      "SHELLX_TEST_INSTANCE_ID",
      "SHELLX_DEBUG_PORT",
      "SHELLX_MCP_PORT",
      "SHELLX_VAULT_E2E",
      "SHELLX_VAULT_PROFILE_DIR",
    ];
    const runId = config.profilePath.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1)
      ?.match(/^shellx-final-webdriver-([a-f0-9]{16,64})$/)?.[1];
    if (!runId) throw new Error(`Windows WebDriver profile is not an attested final profile: ${config.profilePath}`);
    Object.assign(env, {
      HOME: config.profilePath,
      USERPROFILE: config.profilePath,
      LOCALAPPDATA: winJoin(config.profilePath, "AppData", "Local"),
      APPDATA: winJoin(config.profilePath, "AppData", "Roaming"),
      SHELLX_TEST_INSTANCE: "1",
      SHELLX_TEST_INSTANCE_ID: `shellx-final-${runId}`,
      SHELLX_DEBUG_PORT: String(config.debugPort),
      SHELLX_MCP_PORT: String(config.mcpPort),
      SHELLX_VAULT_E2E: "1",
      SHELLX_VAULT_PROFILE_DIR: winJoin(config.profilePath, "vault-e2e"),
    });
    const existing = String(env.WSLENV || "")
      .split(":")
      .filter(Boolean);
    const existingNames = new Set(existing.map((entry) => entry.split("/")[0]));
    env.WSLENV = [
      ...existing,
      ...bridgedVariables.filter((name) => !existingNames.has(name)),
    ].join(":");
  }
  const child = spawn(config.tauriDriver, driverArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  child.stdout?.on("data", (chunk) => process.stdout.write(`[tauri-driver] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[tauri-driver] ${chunk}`));
  child.on("error", (error) => {
    driverSpawnErrors.set(child, error);
  });
  return child;
}

async function main(): Promise<void> {
  const config: AnyDriverConfig = platform === "windows" ? resolveWindowsConfig() : resolveLinuxConfig();
  let child: ChildProcess | null = null;
  let sessionId: string | null = null;
  let primaryError: unknown = null;
  let cleanupEvidence: WindowsCleanupEvidence | null = null;
  let smokeEvidence: SmokeEvidence | null = null;
  let vaultAgentRequestEvidence: VaultAgentRequestEvidence | null = null;
  const preflightOnly = args.has("--preflight-only");
  try {
    console.log(`\n=== Tauri WebDriver smoke (${platform}) ===`);
    console.log(`driver=${config.tauriDriver}`);
    console.log(`app=${config.application}`);
    console.log(`port=${port}`);
    console.log(`nativePort=${nativePort}`);
    if (config.nativeDriver) console.log(`nativeDriver=${config.nativeDriver}`);
    if (config.kind === "windows") {
      console.log(`edgeVersion=${config.edgeVersion}`);
      console.log(`nativeDriverVersion=${config.nativeDriverVersion}`);
      console.log(`nativeDriverSource=${config.nativeDriverSource}`);
      console.log(`applicationSource=${config.applicationSource}`);
      console.log(`applicationVersion=${config.applicationVersion}`);
      console.log(`applicationSha256=${config.applicationSha256}`);
      console.log(`profilePath=${config.profilePath}`);
    }
    assert(existsSync(config.tauriDriver), "tauri-driver binary exists");
    if (platform === "linux") {
      assert(existsSync(config.application), "Linux ShellX binary exists");
      if (!config.nativeDriver) assert(commandExists("WebKitWebDriver"), "WebKitWebDriver is available");
    } else {
      const nativeDriver = config.nativeDriver;
      assert(windowsPathExists(config.application), "Windows ShellX binary exists");
      assert(nativeDriver && windowsPathExists(nativeDriver), "Windows msedgedriver exists");
    }

    if (!preflightOnly) {
      child = launchDriver(config);
      await waitForDriver(child);
      const session = await webdriverRequest("POST", "/session", {
        capabilities: {
          alwaysMatch: {
            "tauri:options": {
              application: config.application,
            },
          },
        },
      });
      const nestedSessionId = session.value && typeof session.value === "object" && !Array.isArray(session.value)
        ? optionalStringProperty(session.value, "sessionId", "WebDriver session value")
        : undefined;
      sessionId = nestedSessionId || session.sessionId || "";
      assert(sessionId, "WebDriver session is created");
      await sleep(4_000);

      const title = await webdriverRequest("GET", `/session/${sessionId}/title`);
      assert(title.value === "shellX", "window title is shellX");

      const source = await webdriverRequest("GET", `/session/${sessionId}/source`);
      const sourceText = String(source.value || "");
      assert(sourceText.length > 1_000, "page source is populated");

      const body = await webdriverRequest("POST", `/session/${sessionId}/execute/sync`, {
        script: "return document.body ? document.body.innerText.slice(0, 3000) : ''",
        args: [],
      });
      const bodyText = String(body.value || "");
      assert(bodyText.includes("OPEN CHATS") || bodyText.includes("new session"), "body text exposes ShellX UI");
      if (args.has("--vault-agent-request")) {
        if (config.kind !== "linux") {
          throw new Error("Vault agent-request WebDriver acceptance is currently supported on Linux");
        }
        const shellxHome = process.env.SHELLX_HOME?.trim()
          || join(process.env.HOME || "", ".shellx");
        vaultAgentRequestEvidence = await runVaultAgentRequestWebdriverGate({
          webdriver: webdriverRequest,
          sessionId,
          shellxHome,
          expectedBuildCommit: process.env.SHELLX_EXPECT_BUILD_COMMIT?.trim(),
          program: process.env.SHELLX_VAULT_AGENT_REQUEST_PROGRAM?.trim(),
        });
        assert(vaultAgentRequestEvidence.trustedWebDriverClick, "trusted WebDriver click approved the Vault executable request");
        assert(vaultAgentRequestEvidence.outputRedacted, "Vault executable output redacts the injected value");
      }
      if (config.kind === "windows") {
        const stableHistoryPath = winJoin(config.hostUserProfile, ".shellx", "sessions");
        const userHistoryProbe = await webdriverRequest("POST", `/session/${sessionId}/execute/sync`, {
          script: "return document.body ? document.body.innerText.includes(arguments[0]) : false",
          args: [stableHistoryPath],
        });
        assert(userHistoryProbe.value === false, "rendered UI excludes the stable user ShellX history path");
        assert(
          windowsPathExists(winJoin(config.profilePath, ".shellx", "debug-api.port")),
          "candidate writes Debug API discovery under the disposable WebDriver home",
        );
      }

      const screenshot = await webdriverRequest("GET", `/session/${sessionId}/screenshot`);
      const png = Buffer.from(String(screenshot.value || ""), "base64");
      writeFileSync(screenshotPath, png);
      const stat = statSync(screenshotPath);
      assert(stat.size > 20_000, `screenshot captured (${basename(screenshotPath)})`);
      smokeEvidence = {
        screenshotBytes: stat.size,
        screenshotSha256: createHash("sha256").update(png).digest("hex"),
      };

      await quitSession(sessionId);
      sessionId = null;
    }
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors: unknown[] = [];
  if (sessionId) await quitSession(sessionId);
  if (child) {
    try {
      await stopDriver(child);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (config.kind === "windows") {
    try {
      cleanupEvidence = cleanupWindowsApplication(config);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (primaryError || cleanupErrors.length > 0) {
    if (primaryError && cleanupErrors.length === 0) throw primaryError;
    const messages = [primaryError, ...cleanupErrors].filter(Boolean).map(errorMessage);
    throw new Error(`WebDriver smoke or cleanup failed: ${messages.join("; ")}`);
  }

  if (preflightOnly) {
    console.log(`\nPASS tauri webdriver preflight (${platform})`);
    return;
  }
  if (!smokeEvidence) throw new Error("WebDriver smoke completed without screenshot evidence");

  const receiptPath = join(evidenceDir, "receipt.json");
  writeFileSync(receiptPath, JSON.stringify({
    schemaVersion: "shellx.tauri-webdriver.v1",
    generatedAt: new Date().toISOString(),
    status: "pass",
    platform,
    application: config.kind === "windows" ? {
      sourcePath: config.applicationSource,
      executablePath: config.application,
      version: config.applicationVersion,
      sha256: config.applicationSha256,
      profilePath: config.profilePath,
      isolatedProfileVerified: true,
    } : {
      executablePath: config.application,
      sha256: createHash("sha256").update(readFileSync(config.application)).digest("hex"),
      buildCommit: vaultAgentRequestEvidence?.buildCommit
        ?? process.env.SHELLX_EXPECT_BUILD_COMMIT?.trim()
        ?? null,
    },
    browser: config.kind === "windows" ? {
      edgeVersion: config.edgeVersion,
      driverVersion: config.nativeDriverVersion,
      driverSource: config.nativeDriverSource,
    } : null,
    screenshot: {
      path: screenshotPath,
      bytes: smokeEvidence.screenshotBytes,
      sha256: smokeEvidence.screenshotSha256,
    },
    vaultAgentRequest: vaultAgentRequestEvidence,
    cleanup: cleanupEvidence,
  }, null, 2));

  console.log(`\nPASS tauri webdriver smoke (${platform})`);
  console.log(`evidence=${screenshotPath}`);
  console.log(`receipt=${receiptPath}`);
}

main().catch((err) => {
  console.error(`\nFAIL tauri webdriver smoke (${platform})`);
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
