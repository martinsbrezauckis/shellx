import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  RELEASE_SURFACE_CANDIDATE_ATTESTATION_SCHEMA,
  parseExactReleaseSurfaceLoopbackBase,
  releaseSurfacePosixPlatform,
  validateReleaseSurfaceCandidateAttestation,
  type ReleaseSurfaceCandidateAttestation,
  type ReleaseSurfaceFileIdentity,
} from "./lib/release-surface-candidate-attestation";
import type { ReleasePlatform } from "./lib/release-surface-inventory";
import {
  loadReleaseSurfaceInstallationReceipt,
  validateReleaseSurfaceInstallationReceipt,
} from "./lib/release-surface-installation-receipt";
import {
  collectReleaseSurfaceWindowsNativeRuntime,
  type ReleaseSurfaceWindowsNativeRuntime,
} from "./lib/release-surface-windows-native-runtime";
import {
  collectReleaseSurfacePosixNativeRuntime,
  type ReleaseSurfacePosixNativeRuntime,
} from "./lib/release-surface-posix-native-runtime";
import {
  collectReleaseSurfaceInstalledPayloadManifestForPlatform,
  isReleaseSurfacePathInsideRoot,
  sameReleaseSurfaceInstalledPayloadManifest,
} from "./lib/release-surface-installed-payload-manifest";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const platform = requiredArg(args, "--platform") as ReleasePlatform;
if (!( ["windows-installed", "macos-installed", "linux-installed"] as string[]).includes(platform)) {
  throw new Error("valid --platform is required");
}
const artifactPath = requiredArg(args, "--artifact");
const installedPayloadPath = requiredArg(args, "--installed-payload");
const processId = Number(requiredArg(args, "--pid"));
const requestedDebugBase = requiredArg(args, "--debug-base");
const debugTokenPath = requiredArg(args, "--debug-token-file");
const requestedMcpBase = requiredArg(args, "--mcp-base");
const mcpTokenPath = requiredArg(args, "--mcp-token-file");
const outputPath = requiredArg(args, "--out");
const installationReceiptPath = requiredArg(args, "--installation-receipt");
if (!Number.isSafeInteger(processId) || processId <= 0) throw new Error("--pid must be a positive integer");
const parsedDebugBase = parseExactReleaseSurfaceLoopbackBase(requestedDebugBase);
if (!parsedDebugBase) throw new Error("--debug-base must be an exact http://127.0.0.1:<port> origin");
const debugBase = parsedDebugBase.origin;
const debugPort = Number(parsedDebugBase.port);
const parsedMcpBase = parseExactReleaseSurfaceLoopbackBase(requestedMcpBase);
if (!parsedMcpBase) throw new Error("--mcp-base must be an exact http://127.0.0.1:<port> origin");
const mcpBase = parsedMcpBase.origin;
const mcpPort = Number(parsedMcpBase.port);
if (mcpPort === debugPort) throw new Error("--mcp-base must use a port distinct from --debug-base");
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (dirty.trim()) throw new Error("candidate attestation requires a clean frozen source checkout");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;

const artifact = identifyRegularFile(artifactPath, "distribution artifact");
const installedNodePath = nodeReadablePath(installedPayloadPath, platform);
const installedPayload = identifyRegularFile(installedNodePath, "installed payload");
const installationReceipt = identifyRegularFile(installationReceiptPath, "installation receipt");
const parsedInstallationReceipt = loadReleaseSurfaceInstallationReceipt(installationReceiptPath);
const installationMethod = parsedInstallationReceipt.method;
const installationErrors = validateReleaseSurfaceInstallationReceipt({
  receipt: parsedInstallationReceipt,
  platform,
  sourceCommit,
  version,
  method: installationMethod,
  artifact,
  installedPayload: { ...installedPayload, path: installedPayloadPath },
});
if (installationErrors.length > 0) throw new Error(`installation receipt is invalid: ${installationErrors.join("; ")}`);
const installedNodeRoot = resolve(nodeReadablePath(parsedInstallationReceipt.payloadManifest.rootPath, platform));
const nodeOutputPath = resolve(nodeReadablePath(outputPath, platform));
if (isReleaseSurfacePathInsideRoot(installedNodeRoot, nodeOutputPath, platform)) {
  throw new Error("candidate attestation output must be outside the installed payload root");
}
const outputParentStat = lstatSync(dirname(nodeOutputPath));
if (outputParentStat.isSymbolicLink() || !outputParentStat.isDirectory()) {
  throw new Error("candidate attestation parent must be a regular non-link directory");
}
const windowsNativeRuntime = platform === "windows-installed"
  ? collectReleaseSurfaceWindowsNativeRuntime({ processId, port: debugPort })
  : undefined;
const posixNativeRuntime = platform !== "windows-installed"
  ? collectReleaseSurfacePosixNativeRuntime({
      platform: releaseSurfacePosixPlatform(platform),
      processId,
      port: debugPort,
    })
  : undefined;
const processImage = processImageIdentity(processId, platform, windowsNativeRuntime, posixNativeRuntime);
if (!samePlatformPath(processImage.path, installedPayloadPath, platform)) {
  throw new Error(`OS process ${processId} image ${processImage.path} does not match ${installedPayloadPath}`);
}
if (processImage.sha256 !== installedPayload.sha256 || processImage.bytes !== installedPayload.bytes) {
  throw new Error("OS process image bytes do not match the installed payload bytes");
}
const debugToken = readSecretFile(nodeReadablePath(debugTokenPath, platform), "debug token");
const healthResponse = await fetch(`${debugBase.replace(/\/$/, "")}/health`, {
  headers: { Authorization: `Bearer ${debugToken}` },
  signal: AbortSignal.timeout(3_000),
});
if (!healthResponse.ok) throw new Error(`candidate /health returned ${healthResponse.status}`);
const health = await healthResponse.json() as Record<string, unknown>;
const protectedResponse = await fetch(`${debugBase.replace(/\/$/, "")}/browser/state`, {
  headers: { Authorization: `Bearer ${debugToken}` },
  signal: AbortSignal.timeout(3_000),
});
await protectedResponse.body?.cancel();
if (!protectedResponse.ok) throw new Error(`candidate protected probe returned ${protectedResponse.status}`);
const mcpToken = await waitForSecretFile(nodeReadablePath(mcpTokenPath, platform), "MCP token");
const mcpHealthResponse = await fetchEventually(`${mcpBase}/health`, {}, "candidate MCP /health");
const mcpHealth = await mcpHealthResponse.json() as Record<string, unknown>;
assertRuntimeHealth(mcpHealth, {
  label: "candidate MCP /health",
  processId,
  instanceId: stringField(health, "instanceId"),
  version,
  sourceCommit,
  port: mcpPort,
  portFields: ["mcpPort", "mcp_port"],
});
const mcpProbeResponse = await fetchEventually(`${mcpBase}/mcp`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${mcpToken}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: "shellx-release-attestation", method: "tools/list", params: {} }),
}, "candidate MCP protected probe");
const mcpProbe = await mcpProbeResponse.json() as Record<string, unknown>;
if (mcpProbe.jsonrpc !== "2.0" || mcpProbe.id !== "shellx-release-attestation"
  || !Array.isArray((mcpProbe.result as Record<string, unknown> | undefined)?.tools)) {
  throw new Error("candidate MCP protected tools/list probe returned an invalid JSON-RPC result");
}
const observedManifest = collectReleaseSurfaceInstalledPayloadManifestForPlatform({
  nodeRootPath: installedNodeRoot,
  recordedRootPath: parsedInstallationReceipt.payloadManifest.rootPath,
  platform,
  scope: parsedInstallationReceipt.payloadManifest.scope,
  mainExecutableRelativePath: parsedInstallationReceipt.payloadManifest.mainExecutableRelativePath,
});
if (!sameReleaseSurfaceInstalledPayloadManifest(parsedInstallationReceipt.payloadManifest, observedManifest)) {
  throw new Error("installed payload manifest changed before candidate attestation");
}
const attestation: ReleaseSurfaceCandidateAttestation = {
  schema: RELEASE_SURFACE_CANDIDATE_ATTESTATION_SCHEMA,
  mode: "final-frozen-candidate",
  platform,
  sourceCommit,
  version,
  createdAt: new Date().toISOString(),
  distributionArtifact: artifact,
  installation: {
    method: installationMethod,
    sourceArtifactSha256: artifact.sha256,
    receipt: installationReceipt,
    payloadManifestSha256: parsedInstallationReceipt.payloadManifest.manifestSha256,
  },
  installedPayload: { ...installedPayload, path: installedPayloadPath },
  process: {
    pid: processId,
    executablePath: processImage.path,
    executableSha256: processImage.sha256,
  },
  runtime: {
    debugBase,
    debugPort,
    debugTokenPath,
    mcpBase,
    mcpPort,
    mcpTokenPath,
    processId: numberField(health, "processId"),
    instanceId: stringField(health, "instanceId"),
    appVersion: stringField(health, "appVersion"),
    buildCommit: stringField(health, "buildCommit"),
  },
  ...(windowsNativeRuntime ? { windowsNativeRuntime } : {}),
  ...(posixNativeRuntime ? { posixNativeRuntime } : {}),
};
const errors = validateReleaseSurfaceCandidateAttestation({
  attestation,
  platform,
  sourceCommit,
  version,
  artifact,
  installationReceipt,
});
if (errors.length > 0) throw new Error(`candidate attestation is invalid: ${errors.join("; ")}`);
writeFileSync(nodeOutputPath, `${JSON.stringify(attestation, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
console.log(`Attested ${platform} candidate PID ${processId}: ${nodeOutputPath}`);

function identifyRegularFile(path: string, label: string): ReleaseSurfaceFileIdentity {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular non-symlink file: ${absolute}`);
  const bytes = readFileSync(absolute);
  if (bytes.length === 0) throw new Error(`${label} must not be empty: ${absolute}`);
  return {
    basename: portableBasename(path),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}

function readSecretFile(path: string, label: string): string {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular non-symlink file: ${absolute}`);
  const value = readFileSync(absolute, "utf8").trim();
  if (value.length < 32) throw new Error(`${label} must contain at least 32 non-whitespace characters`);
  return value;
}

async function waitForSecretFile(path: string, label: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  let lastError = `${label} file is not ready`;
  while (Date.now() < deadline) {
    try {
      return readSecretFile(path, label);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  throw new Error(`${label} did not become readable before timeout: ${lastError}`);
}

async function fetchEventually(url: string, init: RequestInit, label: string): Promise<Response> {
  const deadline = Date.now() + 10_000;
  let lastError = `${label} is not ready`;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(2_000) });
      if (response.ok) return response;
      lastError = `${label} returned ${response.status}`;
      await response.body?.cancel();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`${label} did not become ready before timeout: ${lastError}`);
}

function assertRuntimeHealth(
  value: Record<string, unknown>,
  expected: {
    label: string;
    processId: number;
    instanceId: string;
    version: string;
    sourceCommit: string;
    port: number;
    portFields: [string, string];
  },
): void {
  if (numberField(value, "processId") !== expected.processId) {
    throw new Error(`${expected.label} processId does not match the candidate PID`);
  }
  if (stringField(value, "instanceId") !== expected.instanceId) {
    throw new Error(`${expected.label} instanceId does not match the Debug API run nonce`);
  }
  if (stringField(value, "appVersion") !== expected.version) {
    throw new Error(`${expected.label} appVersion does not match the frozen version`);
  }
  if (stringField(value, "buildCommit") !== expected.sourceCommit) {
    throw new Error(`${expected.label} buildCommit does not match the frozen source commit`);
  }
  const port = value[expected.portFields[0]] ?? value[expected.portFields[1]];
  if (port !== expected.port) {
    throw new Error(`${expected.label} port does not match the reserved endpoint`);
  }
}

function processImageIdentity(
  pid: number,
  platform: ReleasePlatform,
  windowsNativeRuntime?: ReleaseSurfaceWindowsNativeRuntime,
  posixNativeRuntime?: ReleaseSurfacePosixNativeRuntime,
): ReleaseSurfaceFileIdentity & { path: string } {
  if (platform === "windows-installed") {
    if (!windowsNativeRuntime) throw new Error("Windows process identity requires native runtime evidence");
    return {
      path: windowsNativeRuntime.process.imagePath,
      basename: portableBasename(windowsNativeRuntime.process.imagePath),
      sha256: windowsNativeRuntime.process.imageSha256,
      bytes: windowsNativeRuntime.process.imageBytes,
    };
  }
  const path = platform === "linux-installed"
    ? realpathSync(`/proc/${pid}/exe`)
    : macosProcessPath(pid);
  const identity = { ...identifyRegularFile(path, `process ${pid} image`), path };
  if (!posixNativeRuntime) throw new Error("POSIX process identity requires native runtime evidence");
  if (identity.sha256 !== posixNativeRuntime.process.imageSha256
    || identity.bytes !== posixNativeRuntime.process.imageBytes) {
    throw new Error("POSIX process image changed after native runtime collection");
  }
  return identity;
}

function macosProcessPath(pid: number): string {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
  const path = result.stdout.trim();
  if (result.status !== 0 || !path) throw new Error(`macOS process ${pid} is not running or has no executable path`);
  return realpathSync(path);
}

function nodeReadablePath(path: string, platform: ReleasePlatform): string {
  if (platform !== "windows-installed" || process.platform === "win32" || !/^[A-Za-z]:[\\/]/.test(path)) return path;
  const result = spawnSync("wslpath", ["-u", path], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`unable to map installed Windows payload ${path}`);
  return result.stdout.trim();
}

function samePlatformPath(left: string, right: string, platform: ReleasePlatform): boolean {
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "");
  const leftNormalized = normalize(left);
  const rightNormalized = normalize(right);
  return platform === "windows-installed"
    ? leftNormalized.toLowerCase() === rightNormalized.toLowerCase()
    : leftNormalized === rightNormalized;
}

function portableBasename(path: string): string {
  return basename(path.replaceAll("\\", "/"));
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || !field.trim()) throw new Error(`${key} must be a non-empty string`);
  return field;
}

function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (!Number.isSafeInteger(field) || Number(field) <= 0) throw new Error(`${key} must be a positive integer`);
  return Number(field);
}

function requiredArg(values: string[], name: string): string {
  const value = optionalArg(values, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalArg(values: string[], name: string): string | undefined {
  const index = values.indexOf(name);
  const value = index >= 0 ? values[index + 1] : values.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  return value?.trim() || undefined;
}
