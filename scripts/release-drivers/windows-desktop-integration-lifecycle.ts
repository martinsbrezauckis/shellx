import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { resolve } from "node:path";
import type { ReleaseSurfaceDriverRequest } from "../lib/release-surface-driver-protocol";

export const WINDOWS_DESKTOP_INTEGRATION_OBSERVATION_SCHEMA =
  "shellx/release-surface-windows-desktop-integration-observation@1";

export type WindowsDesktopIntegrationPhase = "preflight-absent" | "installed" | "absent";

export interface WindowsDesktopIntegrationObservation {
  schema: typeof WINDOWS_DESKTOP_INTEGRATION_OBSERVATION_SCHEMA;
  phase: WindowsDesktopIntegrationPhase;
  orchestrator: "native" | "wsl";
  observedAt: string;
  userNameSha256: string;
  userSidSha256: string;
  candidatePathSha256: string;
  candidateSha256: string;
  candidateProcessId: number;
  nonAdmin: true;
  candidateOwnedTarget: true;
  candidateOwnerMatches: true;
  debugTokenInsideUserProfile: true;
  fileVerbInstalled: boolean;
  directoryVerbInstalled: boolean;
  sendToShortcutInstalled: boolean;
  exactCandidateValues: boolean;
  mutated: false;
}

type Spawn = (
  command: string,
  args: readonly string[],
  options: { encoding: "utf8"; timeout: number; maxBuffer: number },
) => Pick<SpawnSyncReturns<string>, "status" | "stdout" | "stderr">;

export function observeWindowsDesktopIntegration(
  request: ReleaseSurfaceDriverRequest,
  phase: WindowsDesktopIntegrationPhase,
  dependency?: { spawn?: Spawn; powershellPath?: string; scriptPath?: string; orchestrator?: "native" | "wsl" },
): WindowsDesktopIntegrationObservation {
  assertWindowsRequest(request);
  const orchestrator = dependency?.orchestrator ?? windowsOrchestrator();
  const scriptPath = dependency?.scriptPath ?? windowsReadablePath(resolve(
    import.meta.dirname,
    "..",
    "probe-release-surface-windows-desktop-integration.ps1",
  ));
  const spawn = dependency?.spawn ?? ((command, args, options) => spawnSync(command, args, options));
  const result = spawn(dependency?.powershellPath ?? "powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", scriptPath,
    "-Phase", phase,
    "-CandidateExe", request.runtime.installedPayloadPath,
    "-CandidateSha256", request.runtime.executableSha256,
    "-CandidateProcessId", String(request.runtime.processId),
    "-DebugTokenPath", request.runtime.debugTokenPath,
    "-Orchestrator", orchestrator,
  ], { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "Windows desktop integration observation failed").trim();
    throw new Error(detail);
  }
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) throw new Error("Windows desktop integration observer returned no JSON");
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("Windows desktop integration observer returned invalid JSON");
  }
  return validateObservation(parsed, request, phase, orchestrator);
}

export function validateObservation(
  value: unknown,
  request: ReleaseSurfaceDriverRequest,
  phase: WindowsDesktopIntegrationPhase,
  orchestrator: "native" | "wsl",
): WindowsDesktopIntegrationObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Windows desktop integration observation is not an object");
  }
  const observation = value as Record<string, unknown>;
  const exactKeys = [
    "schema", "phase", "orchestrator", "observedAt", "userNameSha256", "userSidSha256",
    "candidatePathSha256", "candidateSha256", "candidateProcessId", "nonAdmin",
    "candidateOwnedTarget", "candidateOwnerMatches", "debugTokenInsideUserProfile",
    "fileVerbInstalled", "directoryVerbInstalled", "sendToShortcutInstalled",
    "exactCandidateValues", "mutated",
  ];
  const unexpected = Object.keys(observation).filter((key) => !exactKeys.includes(key));
  const missing = exactKeys.filter((key) => !(key in observation));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error("Windows desktop integration observation fields are not exact");
  }
  if (observation.schema !== WINDOWS_DESKTOP_INTEGRATION_OBSERVATION_SCHEMA
    || observation.phase !== phase
    || observation.orchestrator !== orchestrator
    || !Number.isFinite(Date.parse(String(observation.observedAt ?? "")))) {
    throw new Error("Windows desktop integration observation identity is invalid");
  }
  for (const field of ["userNameSha256", "userSidSha256", "candidatePathSha256"] as const) {
    if (!/^[a-f0-9]{64}$/.test(String(observation[field] ?? ""))) {
      throw new Error(`Windows desktop integration observation omitted ${field}`);
    }
  }
  if (observation.candidateSha256 !== request.runtime.executableSha256
    || observation.candidateProcessId !== request.runtime.processId) {
    throw new Error("Windows desktop integration observation drifted from the candidate binding");
  }
  for (const field of [
    "nonAdmin", "candidateOwnedTarget", "candidateOwnerMatches", "debugTokenInsideUserProfile",
  ] as const) {
    if (observation[field] !== true) throw new Error(`Windows desktop integration observation did not prove ${field}`);
  }
  if (observation.mutated !== false) throw new Error("Windows desktop integration observer must remain read-only");
  const installed = phase === "installed";
  for (const field of [
    "fileVerbInstalled", "directoryVerbInstalled", "sendToShortcutInstalled", "exactCandidateValues",
  ] as const) {
    if (observation[field] !== installed) {
      throw new Error(`Windows desktop integration observation returned the wrong ${field} state`);
    }
  }
  return observation as unknown as WindowsDesktopIntegrationObservation;
}

function assertWindowsRequest(request: ReleaseSurfaceDriverRequest): void {
  if (request.platform !== "windows-installed" || !request.runtime.windowsNative) {
    throw new Error("Windows desktop integration proof requires a native Windows candidate binding");
  }
  if (request.runtime.posixNative) {
    throw new Error("Windows desktop integration proof refuses a POSIX runtime binding");
  }
  if (request.runtime.windowsNative.process.pid !== request.runtime.processId
    || request.runtime.windowsNative.process.imageSha256 !== request.runtime.executableSha256
    || normalizeWindowsPath(request.runtime.windowsNative.process.imagePath)
      !== normalizeWindowsPath(request.runtime.installedPayloadPath)) {
    throw new Error("Windows desktop integration proof candidate binding is inconsistent");
  }
}

function windowsReadablePath(path: string): string {
  if (process.platform === "win32") return path;
  if (!process.env.WSL_INTEROP?.trim()) {
    throw new Error("Windows desktop integration proof requires native Windows or WSL interop");
  }
  const result = spawnSync("wslpath", ["-w", path], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error("unable to map the Windows desktop integration observer path");
  }
  return result.stdout.trim();
}

function windowsOrchestrator(): "native" | "wsl" {
  if (process.platform === "win32") return "native";
  if (process.env.WSL_INTEROP?.trim()) return "wsl";
  throw new Error("Windows desktop integration proof requires native Windows or WSL interop");
}

function normalizeWindowsPath(value: string): string {
  return value.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
}
