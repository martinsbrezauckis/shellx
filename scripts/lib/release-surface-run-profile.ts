import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ReleasePlatform } from "./release-surface-inventory";

export const RELEASE_SURFACE_RUN_PROFILE_SCHEMA = "shellx/release-surface-run-profile@1";
export const RELEASE_SURFACE_RUN_PROFILE_CLEANUP_SCHEMA =
  "shellx/release-surface-run-profile-cleanup@1";

const PROFILE_NAME = /^shellx-final-webdriver-([a-f0-9]{16,64})$/;
const MARKER_NAME = "shellx-final-profile.json";

export function releaseSurfaceProfileLaunchRootFromDebugTokenPath(
  debugTokenPath: string,
  platform: ReleasePlatform,
): string {
  if (!debugTokenPath.trim() || /[\r\n\0]/.test(debugTokenPath)) {
    throw new Error("release profile Debug API token path is invalid");
  }
  const windows = platform === "windows-installed";
  const normalized = windows ? debugTokenPath.replaceAll("/", "\\") : debugTokenPath;
  const suffix = windows ? "\\.shellx\\shellxagent.token" : "/.shellx/shellxagent.token";
  if (!normalized.toLowerCase().endsWith(suffix)) {
    throw new Error("release profile Debug API token path is outside the exact .shellx token location");
  }
  const root = normalized.slice(0, -suffix.length);
  if (windows ? !/^[A-Za-z]:\\/.test(root) : !root.startsWith("/")) {
    throw new Error("release profile launch root is not platform-absolute");
  }
  return root;
}

export function releaseSurfaceProfileMarkerLaunchPath(
  debugTokenPath: string,
  platform: ReleasePlatform,
): string {
  const root = releaseSurfaceProfileLaunchRootFromDebugTokenPath(debugTokenPath, platform);
  return `${root}${platform === "windows-installed" ? "\\" : "/"}${MARKER_NAME}`;
}

export interface ReleaseSurfaceRunProfile {
  schema: typeof RELEASE_SURFACE_RUN_PROFILE_SCHEMA;
  platform: Extract<ReleasePlatform, "windows-installed" | "macos-installed" | "linux-installed">;
  runId: string;
  nodePath: string;
  launchPath: string;
  markerPath: string;
  debugBase: string;
  debugPort: number;
  mcpBase: string;
  mcpPort: number;
  debugTokenNodePath: string;
  debugTokenLaunchPath: string;
  mcpTokenNodePath: string;
  mcpTokenLaunchPath: string;
  environment: NodeJS.ProcessEnv;
}

export interface ReleaseSurfaceRunProfileCleanupReceipt {
  schema: typeof RELEASE_SURFACE_RUN_PROFILE_CLEANUP_SCHEMA;
  mode: "final-frozen-candidate";
  status: "pass" | "failed";
  platform: ReleaseSurfaceRunProfile["platform"];
  runId: string;
  startedAt: string;
  completedAt: string;
  profilePathSha256: string;
  application: {
    processId?: number;
    alreadyStopped: boolean;
    identityVerifiedBeforeStop: boolean;
    forcedStop: boolean;
    processCountAfter: number;
  };
  nativeDriver: {
    configured: boolean;
    forcedStopCount: number;
    processCountAfter: number;
  };
  listeners: {
    debugCountAfter: number;
    mcpCountAfter: number;
  };
  profile: {
    markerVerified: boolean;
    removed: boolean;
  };
  error?: string;
}

export interface ReleaseSurfaceRunProfileCleanupInput {
  profile: ReleaseSurfaceRunProfile;
  evidencePath: string;
  application?: { processId: number; executableNodePath: string; executableLaunchPath: string };
  nativeDriver?: { executableLaunchPath: string; nativePort: number };
  shutdownTimeoutMs?: number;
}

export class ReleaseSurfaceRunProfileCleanupError extends Error {
  constructor(message: string, readonly receipt: ReleaseSurfaceRunProfileCleanupReceipt) {
    super(message);
    this.name = "ReleaseSurfaceRunProfileCleanupError";
  }
}

export function prepareReleaseSurfaceRunProfile(input: {
  platform: ReleaseSurfaceRunProfile["platform"];
  runId: string;
  nodePath: string;
  launchPath: string;
  debugPort: number;
  mcpPort: number;
  baseEnvironment?: NodeJS.ProcessEnv;
}): ReleaseSurfaceRunProfile {
  if (!/^[a-f0-9]{16,64}$/.test(input.runId)) throw new Error("release run id must be 16 to 64 lowercase hex characters");
  if (!validPort(input.debugPort) || !validPort(input.mcpPort) || input.debugPort === input.mcpPort) {
    throw new Error("release profile Debug API and MCP ports must be distinct valid TCP ports");
  }
  const nodePath = resolve(input.nodePath);
  if (basename(nodePath) !== `shellx-final-webdriver-${input.runId}` || !PROFILE_NAME.test(basename(nodePath))) {
    throw new Error("release profile must use the exact shellx-final-webdriver-<run-id> name");
  }
  const parent = lstatSync(dirname(nodePath));
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new Error("release profile parent must be a regular non-link directory");
  }
  if (existsSync(nodePath)) throw new Error(`release profile must be absent before creation: ${nodePath}`);
  const launchPath = validateLaunchPath(input.platform, nodePath, input.launchPath);
  mkdirSync(join(nodePath, "AppData", "Local"), { recursive: true, mode: 0o700 });
  mkdirSync(join(nodePath, "AppData", "Roaming"), { recursive: true, mode: 0o700 });
  mkdirSync(join(nodePath, "vault-e2e"), { recursive: true, mode: 0o700 });
  const markerPath = join(nodePath, MARKER_NAME);
  writeFileSync(markerPath, `${JSON.stringify({
    schema: RELEASE_SURFACE_RUN_PROFILE_SCHEMA,
    platform: input.platform,
    runId: input.runId,
    nodePath,
    launchPath,
  }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const windows = input.platform === "windows-installed";
  const debugTokenNodePath = join(nodePath, ".shellx", "shellxagent.token");
  const debugTokenLaunchPath = platformJoin(launchPath, ".shellx", "shellxagent.token", windows);
  const mcpTokenNodePath = join(nodePath, ".shellx", "mcp.token");
  const mcpTokenLaunchPath = platformJoin(launchPath, ".shellx", "mcp.token", windows);
  const environment: NodeJS.ProcessEnv = {
    ...(input.baseEnvironment ?? process.env),
    HOME: launchPath,
    SHELLX_TEST_INSTANCE: "1",
    SHELLX_TEST_INSTANCE_ID: `shellx-final-${input.runId}`,
    SHELLX_MIGRATE_DATA_DIR: "0",
    SHELLX_DEBUG_PORT: String(input.debugPort),
    SHELLX_MCP_PORT: String(input.mcpPort),
    SHELLX_MCP_MARKETPLACE_E2E: "1",
    SHELLX_VAULT_E2E: "1",
    SHELLX_VAULT_PROFILE_DIR: platformJoin(launchPath, "vault-e2e", undefined, windows),
  };
  // Final candidate evidence must use the disposable profile's exact token
  // file, never an inherited process-wide MCP secret with no durable path.
  delete environment.SHELLX_MCP_SECRET;
  if (windows) {
    environment.USERPROFILE = launchPath;
    environment.LOCALAPPDATA = platformJoin(launchPath, "AppData", "Local", true);
    environment.APPDATA = platformJoin(launchPath, "AppData", "Roaming", true);
    environment.WSLENV = bridgeWindowsEnvironment(environment.WSLENV);
  }
  if (input.platform === "macos-installed" && process.platform === "darwin") {
    try {
      prepareMacosEphemeralKeychain(nodePath);
    } catch (error) {
      try {
        cleanupMacosEphemeralKeychain(nodePath);
      } catch {
        // Preserve the preparation error; the owned profile is removed below.
      }
      rmSync(nodePath, { recursive: true, force: true });
      throw new Error(`unable to prepare disposable macOS keychain: ${errorMessage(error)}`);
    }
  }
  return {
    schema: RELEASE_SURFACE_RUN_PROFILE_SCHEMA,
    platform: input.platform,
    runId: input.runId,
    nodePath,
    launchPath,
    markerPath,
    debugBase: `http://127.0.0.1:${input.debugPort}`,
    debugPort: input.debugPort,
    mcpBase: `http://127.0.0.1:${input.mcpPort}`,
    mcpPort: input.mcpPort,
    debugTokenNodePath,
    debugTokenLaunchPath,
    mcpTokenNodePath,
    mcpTokenLaunchPath,
    environment,
  };
}

export async function cleanupReleaseSurfaceRunProfile(
  input: ReleaseSurfaceRunProfileCleanupInput,
): Promise<ReleaseSurfaceRunProfileCleanupReceipt> {
  validateEvidencePath(input.evidencePath);
  const startedAt = new Date().toISOString();
  let markerVerified = false;
  let removed = false;
  let application = {
    alreadyStopped: true,
    identityVerifiedBeforeStop: false,
    forcedStop: false,
    processCountAfter: 0,
  } as
    ReleaseSurfaceRunProfileCleanupReceipt["application"];
  let nativeDriver = { configured: Boolean(input.nativeDriver), forcedStopCount: 0, processCountAfter: 0 };
  let listeners = { debugCountAfter: -1, mcpCountAfter: -1 };
  let primaryError: unknown = null;
  try {
    verifyProfileMarker(input.profile);
    markerVerified = true;
    if (input.profile.platform === "windows-installed") {
      const result = cleanupWindowsProcesses(input.application, input.nativeDriver, input.shutdownTimeoutMs ?? 10_000);
      application = result.application;
      nativeDriver = result.nativeDriver;
    } else if (input.application) {
      application = await cleanupPosixApplication(
        input.profile.platform,
        input.application,
        input.shutdownTimeoutMs ?? 10_000,
      );
    }
    if (application.processCountAfter !== 0 || nativeDriver.processCountAfter !== 0) {
      throw new Error("owned release processes remain after bounded cleanup");
    }
    listeners = await waitForListenerCleanup(input.profile, input.shutdownTimeoutMs ?? 10_000);
    if (listeners.debugCountAfter !== 0 || listeners.mcpCountAfter !== 0) {
      throw new Error("candidate loopback listeners remain after bounded cleanup");
    }
    if (input.profile.platform === "macos-installed") {
      cleanupMacosEphemeralKeychain(input.profile.nodePath);
    }
    await removeProfile(input.profile.nodePath, input.shutdownTimeoutMs ?? 10_000);
    removed = true;
  } catch (error) {
    primaryError = error;
  }
  const receipt: ReleaseSurfaceRunProfileCleanupReceipt = {
    schema: RELEASE_SURFACE_RUN_PROFILE_CLEANUP_SCHEMA,
    mode: "final-frozen-candidate",
    status: primaryError ? "failed" : "pass",
    platform: input.profile.platform,
    runId: input.profile.runId,
    startedAt,
    completedAt: new Date().toISOString(),
    profilePathSha256: sha256(input.profile.launchPath),
    application,
    nativeDriver,
    listeners,
    profile: { markerVerified, removed },
    ...(primaryError ? { error: errorMessage(primaryError) } : {}),
  };
  writeCreateOnlyReceipt(input.evidencePath, receipt);
  if (primaryError) throw new ReleaseSurfaceRunProfileCleanupError(errorMessage(primaryError), receipt);
  return receipt;
}

function prepareMacosEphemeralKeychain(profileRoot: string): void {
  const keychainDirectory = join(profileRoot, "Library", "Keychains");
  const keychainPath = join(keychainDirectory, "login.keychain-db");
  mkdirSync(keychainDirectory, { recursive: true, mode: 0o700 });
  const password = randomBytes(32).toString("hex");
  runMacosSecurity(profileRoot, ["create-keychain", "-p", password, keychainPath]);
  runMacosSecurity(profileRoot, ["list-keychains", "-d", "user", "-s", keychainPath]);
  runMacosSecurity(profileRoot, ["default-keychain", "-d", "user", "-s", keychainPath]);
  runMacosSecurity(profileRoot, ["unlock-keychain", "-p", password, keychainPath]);
  runMacosSecurity(profileRoot, ["set-keychain-settings", "-lut", "21600", keychainPath]);
  const defaultKeychain = runMacosSecurity(profileRoot, ["default-keychain", "-d", "user"])
    .trim()
    .replace(/^"|"$/g, "");
  // macOS reports /private/var for keychains created below Node's /var
  // tmpdir alias. Compare the resolved filesystem identities, not the two
  // lexical spellings of the same file.
  if (realpathSync(defaultKeychain) !== realpathSync(keychainPath)) {
    throw new Error("disposable macOS keychain did not become the isolated profile default");
  }
  const stat = lstatSync(keychainPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("disposable macOS keychain is not a regular file");
  }
}

function cleanupMacosEphemeralKeychain(profileRoot: string): void {
  if (process.platform !== "darwin") return;
  const keychainPath = join(profileRoot, "Library", "Keychains", "login.keychain-db");
  if (!existsSync(keychainPath)) return;
  runMacosSecurity(profileRoot, ["delete-keychain", keychainPath]);
  if (existsSync(keychainPath)) throw new Error("disposable macOS keychain remained after deletion");
}

function runMacosSecurity(profileRoot: string, args: string[]): string {
  const result = spawnSync("/usr/bin/security", args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    env: { ...process.env, HOME: profileRoot },
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "macOS security command failed").trim());
  }
  return result.stdout;
}

function verifyProfileMarker(profile: ReleaseSurfaceRunProfile): void {
  if (!/^[a-f0-9]{16,64}$/.test(profile.runId)
    || resolve(profile.nodePath) !== profile.nodePath
    || basename(profile.nodePath) !== `shellx-final-webdriver-${profile.runId}`) {
    throw new Error("release profile identity is invalid during cleanup");
  }
  const profileStat = lstatSync(profile.nodePath);
  if (profileStat.isSymbolicLink() || !profileStat.isDirectory()) {
    throw new Error("release profile must remain a regular non-link directory");
  }
  if (resolve(profile.markerPath) !== join(resolve(profile.nodePath), MARKER_NAME)) {
    throw new Error("release profile marker path drifted outside the exact profile");
  }
  const stat = lstatSync(profile.markerPath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("release profile marker must be a regular non-link file");
  const value = JSON.parse(readFileSync(profile.markerPath, "utf8")) as Record<string, unknown>;
  for (const [field, expected] of [
    ["schema", RELEASE_SURFACE_RUN_PROFILE_SCHEMA],
    ["platform", profile.platform],
    ["runId", profile.runId],
    ["nodePath", profile.nodePath],
    ["launchPath", profile.launchPath],
  ] as const) {
    if (value[field] !== expected) throw new Error(`release profile marker ${field} does not match`);
  }
}

async function cleanupPosixApplication(
  platform: Extract<ReleaseSurfaceRunProfile["platform"], "macos-installed" | "linux-installed">,
  application: NonNullable<ReleaseSurfaceRunProfileCleanupInput["application"]>,
  timeoutMs: number,
): Promise<ReleaseSurfaceRunProfileCleanupReceipt["application"]> {
  if (!Number.isSafeInteger(application.processId) || application.processId <= 0) {
    throw new Error("candidate application PID must be a positive integer");
  }
  if (!posixProcessExists(platform, application.processId)) {
    return stoppedPosixApplicationReceipt(application.processId);
  }
  const expected = realpathSync(application.executableNodePath);
  const actual = posixProcessExecutablePath(platform, application.processId);
  if (actual === null) return stoppedPosixApplicationReceipt(application.processId);
  if (actual !== expected) throw new Error(`refusing to stop PID ${application.processId}: executable identity drifted`);
  process.kill(application.processId, "SIGTERM");
  let forcedStop = false;
  if (!await waitForPosixExit(platform, application.processId, Math.floor(timeoutMs / 2))) {
    process.kill(application.processId, "SIGKILL");
    forcedStop = true;
  }
  const stopped = await waitForPosixExit(platform, application.processId, Math.ceil(timeoutMs / 2));
  if (!stopped) throw new Error(`owned candidate PID ${application.processId} did not stop`);
  return {
    processId: application.processId,
    alreadyStopped: false,
    identityVerifiedBeforeStop: true,
    forcedStop,
    processCountAfter: 0,
  };
}

function stoppedPosixApplicationReceipt(
  processId: number,
): ReleaseSurfaceRunProfileCleanupReceipt["application"] {
  return {
    processId,
    alreadyStopped: true,
    identityVerifiedBeforeStop: false,
    forcedStop: false,
    processCountAfter: 0,
  };
}

function cleanupWindowsProcesses(
  application: ReleaseSurfaceRunProfileCleanupInput["application"],
  nativeDriver: ReleaseSurfaceRunProfileCleanupInput["nativeDriver"],
  timeoutMs: number,
): Pick<ReleaseSurfaceRunProfileCleanupReceipt, "application" | "nativeDriver"> {
  const appPid = application?.processId ?? 0;
  const appPath = application?.executableLaunchPath ?? "";
  const nativePath = nativeDriver?.executableLaunchPath ?? "";
  const nativePort = nativeDriver?.nativePort ?? 0;
  const output = runPowerShell([
    "$ErrorActionPreference = 'Stop'",
    `$appPid = ${appPid}`,
    `$appPath = ${powerShellLiteral(appPath)}`,
    `$nativePath = ${powerShellLiteral(nativePath)}`,
    `$nativePort = ${nativePort}`,
    `$deadline = [DateTime]::UtcNow.AddMilliseconds(${Math.max(1_000, timeoutMs)})`,
    ...windowsLoopbackListenerFunctionSource(),
    "$appWasRunning = $false; $appForced = $false",
    "if ($appPid -gt 0) {",
    "  $app = Get-Process -Id $appPid -ErrorAction SilentlyContinue",
    "  if ($app) {",
    "    $appWasRunning = $true",
    "    if (-not $app.Path -or -not ([IO.Path]::GetFullPath($app.Path)).Equals([IO.Path]::GetFullPath($appPath), [StringComparison]::OrdinalIgnoreCase)) { throw 'candidate PID image mismatch' }",
    "    Stop-Process -Id $appPid -Force; $appForced = $true",
    "  }",
    "}",
    "$nativeForced = 0",
    "if ($nativePath -and $nativePort -gt 0) {",
    "  foreach ($ownerPid in @(Get-LoopbackListenerOwnerIds $nativePort)) {",
    "    $nativeProcess = Get-Process -Id $ownerPid -ErrorAction Stop",
    "    if (-not $nativeProcess.Path -or -not ([IO.Path]::GetFullPath($nativeProcess.Path)).Equals([IO.Path]::GetFullPath($nativePath), [StringComparison]::OrdinalIgnoreCase)) { throw 'native driver listener owner image mismatch' }",
    "    Stop-Process -Id $ownerPid -Force -ErrorAction Stop; $nativeForced += 1",
    "  }",
    "}",
    "do {",
    "  $appRemaining = if ($appPid -gt 0) { @(Get-Process -Id $appPid -ErrorAction SilentlyContinue).Count } else { 0 }",
    "  $nativeRemaining = 0",
    "  if ($nativePath -and $nativePort -gt 0) { $nativeRemaining = @(Get-LoopbackListenerOwnerIds $nativePort).Count }",
    "  if (($appRemaining + $nativeRemaining) -eq 0) { break }",
    "  Start-Sleep -Milliseconds 100",
    "} while ([DateTime]::UtcNow -lt $deadline)",
    "[pscustomobject]@{ appWasRunning = $appWasRunning; appForced = $appForced; appRemaining = $appRemaining; nativeForced = $nativeForced; nativeRemaining = $nativeRemaining } | ConvertTo-Json -Compress",
  ].join("\n"));
  const value = JSON.parse(output) as Record<string, unknown>;
  return {
    application: {
      ...(application ? { processId: application.processId } : {}),
      alreadyStopped: application ? value.appWasRunning !== true : true,
      identityVerifiedBeforeStop: application ? value.appWasRunning === true : false,
      forcedStop: value.appForced === true,
      processCountAfter: numberValue(value.appRemaining, "appRemaining"),
    },
    nativeDriver: {
      configured: Boolean(nativeDriver),
      forcedStopCount: numberValue(value.nativeForced, "nativeForced"),
      processCountAfter: numberValue(value.nativeRemaining, "nativeRemaining"),
    },
  };
}

export function releaseSurfaceCandidateProcessExists(
  platform: ReleaseSurfaceRunProfile["platform"],
  processId: number,
  executablePath: string,
): boolean {
  if (!Number.isSafeInteger(processId) || processId <= 0) throw new Error("candidate PID must be a positive integer");
  if (!executablePath.trim() || /[\r\n\0]/.test(executablePath)) throw new Error("candidate executable path is invalid");
  if (platform === "windows-installed") {
    const output = runPowerShell([
      "$ErrorActionPreference = 'Stop'",
      `$processId = ${processId}`,
      `$expectedPath = ${powerShellLiteral(executablePath)}`,
      "$candidate = Get-Process -Id $processId -ErrorAction SilentlyContinue",
      "if (-not $candidate) { 'false'; exit 0 }",
      "if (-not $candidate.Path -or -not ([IO.Path]::GetFullPath($candidate.Path)).Equals([IO.Path]::GetFullPath($expectedPath), [StringComparison]::OrdinalIgnoreCase)) { throw 'candidate PID image mismatch' }",
      "'true'",
    ].join("\n"));
    if (output === "true") return true;
    if (output === "false") return false;
    throw new Error("Windows candidate process observer returned an invalid result");
  }
  const posixPlatform = platform as Extract<ReleaseSurfaceRunProfile["platform"], "macos-installed" | "linux-installed">;
  if (!posixProcessExists(posixPlatform, processId)) return false;
  const actual = posixProcessExecutablePath(posixPlatform, processId);
  if (!actual) return false;
  if (actual !== realpathSync(executablePath)) throw new Error("candidate PID image mismatch");
  return true;
}

function observeListenerCountsAfterCleanup(
  profile: ReleaseSurfaceRunProfile,
): ReleaseSurfaceRunProfileCleanupReceipt["listeners"] {
  if (profile.platform === "windows-installed") {
    const output = runPowerShell([
      "$ErrorActionPreference = 'Stop'",
      `$debugPort = ${profile.debugPort}`,
      `$mcpPort = ${profile.mcpPort}`,
      ...windowsLoopbackListenerFunctionSource(),
      "$debugCount = @(Get-LoopbackListenerOwnerIds $debugPort).Count",
      "$mcpCount = @(Get-LoopbackListenerOwnerIds $mcpPort).Count",
      "[pscustomobject]@{ debugCount = $debugCount; mcpCount = $mcpCount } | ConvertTo-Json -Compress",
    ].join("\n"));
    const value = JSON.parse(output) as Record<string, unknown>;
    return {
      debugCountAfter: numberValue(value.debugCount, "debugCount"),
      mcpCountAfter: numberValue(value.mcpCount, "mcpCount"),
    };
  }
  return profile.platform === "macos-installed"
    ? {
        debugCountAfter: macosListeningSocketCount(profile.debugPort),
        mcpCountAfter: macosListeningSocketCount(profile.mcpPort),
      }
    : {
        debugCountAfter: linuxListeningSocketCount(profile.debugPort),
        mcpCountAfter: linuxListeningSocketCount(profile.mcpPort),
      };
}

async function waitForListenerCleanup(
  profile: ReleaseSurfaceRunProfile,
  timeoutMs: number,
): Promise<ReleaseSurfaceRunProfileCleanupReceipt["listeners"]> {
  const deadline = Date.now() + timeoutMs;
  let counts = observeListenerCountsAfterCleanup(profile);
  while ((counts.debugCountAfter !== 0 || counts.mcpCountAfter !== 0) && Date.now() < deadline) {
    await delay(50);
    counts = observeListenerCountsAfterCleanup(profile);
  }
  return counts;
}

function windowsLoopbackListenerFunctionSource(): string[] {
  return [
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
  ];
}

function linuxListeningSocketCount(port: number): number {
  const portHex = port.toString(16).toUpperCase().padStart(4, "0");
  let count = 0;
  for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/).slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 4) continue;
      const localPort = fields[1]?.split(":").at(-1)?.toUpperCase();
      if (localPort === portHex && fields[3] === "0A") count += 1;
    }
  }
  return count;
}

function macosListeningSocketCount(port: number): number {
  const result = spawnSync("/usr/sbin/lsof", [
    "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp",
  ], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (result.status === 1 && !result.stdout.trim()) return 0;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `unable to inspect macOS listener ${port}`).trim());
  }
  return new Set(result.stdout.split(/\r?\n/)
    .filter((line) => /^p\d+$/.test(line))
    .map((line) => line.slice(1))).size;
}

function validateLaunchPath(platform: ReleaseSurfaceRunProfile["platform"], nodePath: string, launchPath: string): string {
  if (!launchPath.trim() || /[\r\n\0]/.test(launchPath)) throw new Error("release profile launch path is invalid");
  if (platform === "linux-installed" || platform === "macos-installed") {
    const absolute = resolve(launchPath);
    if (absolute !== nodePath) throw new Error("POSIX release profile launch path must equal its node-readable path");
    return absolute;
  }
  if (!/^[A-Za-z]:[\\/]/.test(launchPath)) throw new Error("Windows release profile launch path must be drive-absolute");
  const mapped = spawnSync("wslpath", ["-w", nodePath], { encoding: "utf8" });
  if (process.platform !== "win32" && mapped.status !== 0) throw new Error("unable to map Windows release profile node path");
  const expected = process.platform === "win32" ? nodePath : mapped.stdout.trim();
  if (normalizeWindowsPath(expected) !== normalizeWindowsPath(launchPath)) {
    throw new Error("Windows release profile node and launch paths do not identify the same directory");
  }
  return launchPath.replaceAll("/", "\\").replace(/[\\]+$/, "");
}

function bridgeWindowsEnvironment(existingValue: string | undefined): string {
  const required = [
    "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "SHELLX_TEST_INSTANCE",
    "SHELLX_TEST_INSTANCE_ID", "SHELLX_MIGRATE_DATA_DIR", "SHELLX_DEBUG_PORT",
    "SHELLX_MCP_PORT", "SHELLX_MCP_MARKETPLACE_E2E", "SHELLX_VAULT_E2E", "SHELLX_VAULT_PROFILE_DIR",
  ];
  const existing = String(existingValue ?? "").split(":").filter(Boolean);
  const names = new Set(existing.map((entry) => entry.split("/")[0]));
  return [...existing, ...required.filter((name) => !names.has(name))].join(":");
}

async function removeProfile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      rmSync(path, { recursive: true });
      if (!existsSync(path)) return;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`owned release profile was not removed: ${errorMessage(lastError)}`);
}

function writeCreateOnlyReceipt(path: string, receipt: ReleaseSurfaceRunProfileCleanupReceipt): void {
  const absolute = resolve(path);
  writeFileSync(absolute, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function validateEvidencePath(path: string): void {
  const absolute = resolve(path);
  const parent = lstatSync(dirname(absolute));
  if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Error("cleanup evidence parent must be a regular non-link directory");
  if (existsSync(absolute)) throw new Error(`cleanup evidence already exists: ${absolute}`);
}

function linuxProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0 || stat.length <= commandEnd + 2) {
      throw new Error(`candidate PID ${pid} has an invalid proc status`);
    }
    return stat[commandEnd + 2] !== "Z";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function linuxProcessExecutablePath(pid: number): string | null {
  try {
    return realpathSync(`/proc/${pid}/exe`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !linuxProcessExists(pid)) return null;
    throw error;
  }
}

function macosProcessExecutablePath(pid: number): string | null {
  const result = spawnSync("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "txt", "-Fn"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    if (!macosProcessExists(pid)) return null;
    throw new Error((result.stderr || result.stdout || `unable to inspect macOS PID ${pid}`).trim());
  }
  const path = result.stdout.split(/\r?\n/).find((line) => line.startsWith("n") && line.length > 1)?.slice(1);
  if (!path) throw new Error(`macOS PID ${pid} has no executable text image`);
  return realpathSync(path);
}

function macosProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

function posixProcessExists(
  platform: Extract<ReleaseSurfaceRunProfile["platform"], "macos-installed" | "linux-installed">,
  pid: number,
): boolean {
  return platform === "macos-installed" ? macosProcessExists(pid) : linuxProcessExists(pid);
}

function posixProcessExecutablePath(
  platform: Extract<ReleaseSurfaceRunProfile["platform"], "macos-installed" | "linux-installed">,
  pid: number,
): string | null {
  return platform === "macos-installed" ? macosProcessExecutablePath(pid) : linuxProcessExecutablePath(pid);
}

async function waitForPosixExit(
  platform: Extract<ReleaseSurfaceRunProfile["platform"], "macos-installed" | "linux-installed">,
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!posixProcessExists(platform, pid)) return true;
    await delay(50);
  }
  return !posixProcessExists(platform, pid);
}

function runPowerShell(script: string): string {
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
  ], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || result.error?.message || "PowerShell failed").trim());
  return result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
}

function platformJoin(root: string, first: string, second: string | undefined, windows: boolean): string {
  return [root, first, second].filter(Boolean).join(windows ? "\\" : "/").replace(windows ? /\\+/g : /\/+/g, windows ? "\\" : "/");
}

function normalizeWindowsPath(path: string): string {
  return path.replaceAll("/", "\\").replace(/[\\]+$/, "").toLowerCase();
}

function powerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function numberValue(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`PowerShell ${label} must be a non-negative integer`);
  return Number(value);
}

function validPort(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 65_535;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
