import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export const RELEASE_SURFACE_WINDOWS_NATIVE_RUNTIME_SCHEMA =
  "shellx/release-surface-windows-native-runtime@1";
export const RELEASE_SURFACE_WINDOWS_NATIVE_BINDING_SCHEMA =
  "shellx/release-surface-windows-native-binding@1";
export const RELEASE_SURFACE_WINDOWS_CLOCK_SKEW_MS = 5 * 60_000;
export const RELEASE_SURFACE_WINDOWS_OBSERVATION_MAX_AGE_MS = 60_000;

export interface ReleaseSurfaceWindowsNativeRuntime {
  schema: typeof RELEASE_SURFACE_WINDOWS_NATIVE_RUNTIME_SCHEMA;
  collector: "windows-powershell-v1";
  orchestrator: "native" | "wsl";
  observedAt: string;
  osVersion: string;
  architecture: string;
  process: {
    pid: number;
    startId: string;
    imagePath: string;
    imageSha256: string;
    imageBytes: number;
    imageFileId: string;
  };
  listener: {
    address: "127.0.0.1";
    port: number;
    owningPid: number;
  };
}

export interface ReleaseSurfaceWindowsNativeBinding {
  schema: typeof RELEASE_SURFACE_WINDOWS_NATIVE_BINDING_SCHEMA;
  process: ReleaseSurfaceWindowsNativeRuntime["process"];
  listener: ReleaseSurfaceWindowsNativeRuntime["listener"];
}

export function collectReleaseSurfaceWindowsNativeRuntime(input: {
  processId: number;
  port: number;
  powershellPath?: string;
}): ReleaseSurfaceWindowsNativeRuntime {
  if (!Number.isSafeInteger(input.processId) || input.processId <= 0) throw new Error("Windows runtime PID must be positive");
  if (!Number.isSafeInteger(input.port) || input.port <= 0 || input.port > 65535) throw new Error("Windows runtime port is invalid");
  const orchestrator = resolveWindowsOrchestrator();
  const powershell = input.powershellPath ?? "powershell.exe";
  const scriptPath = windowsReadablePath(resolve(import.meta.dirname, "..", "collect-release-surface-windows-runtime.ps1"));
  const result = spawnSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", scriptPath,
    "-ProcessId", String(input.processId),
    "-Port", String(input.port),
    "-Orchestrator", orchestrator,
  ], { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "Windows native runtime collection failed").trim());
  }
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) throw new Error("Windows native runtime collector returned no JSON");
  const observation = JSON.parse(line) as ReleaseSurfaceWindowsNativeRuntime;
  const errors = validateReleaseSurfaceWindowsNativeRuntime(observation, {
    processId: input.processId,
    port: input.port,
    orchestrator,
  });
  if (errors.length > 0) throw new Error(`Windows native runtime evidence is invalid: ${errors.join("; ")}`);
  return observation;
}

export function validateReleaseSurfaceWindowsNativeRuntime(
  observation: ReleaseSurfaceWindowsNativeRuntime,
  expected: {
    processId: number;
    port: number;
    orchestrator?: "native" | "wsl";
    imagePath?: string;
    imageSha256?: string;
  },
): string[] {
  const errors: string[] = [];
  if (observation.schema !== RELEASE_SURFACE_WINDOWS_NATIVE_RUNTIME_SCHEMA) {
    errors.push(`schema must be ${RELEASE_SURFACE_WINDOWS_NATIVE_RUNTIME_SCHEMA}`);
  }
  if (observation.collector !== "windows-powershell-v1") errors.push("collector must be windows-powershell-v1");
  if (!(["native", "wsl"] as string[]).includes(observation.orchestrator)) errors.push("orchestrator must be native or wsl");
  if (expected.orchestrator && observation.orchestrator !== expected.orchestrator) errors.push("orchestrator does not match the caller");
  if (!Number.isFinite(Date.parse(observation.observedAt))) errors.push("observedAt must be a valid ISO timestamp");
  if (!observation.osVersion?.trim()) errors.push("osVersion is required");
  if (!observation.architecture?.trim()) errors.push("architecture is required");
  if (observation.process?.pid !== expected.processId) errors.push("process PID does not match");
  if (!Number.isFinite(Date.parse(observation.process?.startId))) errors.push("process startId must be a valid ISO timestamp");
  if (Number.isFinite(Date.parse(observation.observedAt))
    && Number.isFinite(Date.parse(observation.process?.startId))
    && Date.parse(observation.process.startId) > Date.parse(observation.observedAt)) {
    errors.push("process startId must not follow observedAt");
  }
  if (!observation.process?.imagePath?.trim()) errors.push("process imagePath is required");
  if (!/^[a-f0-9]{64}$/.test(observation.process?.imageSha256 ?? "")) errors.push("process imageSha256 must be 64 lowercase hex characters");
  if (!Number.isSafeInteger(observation.process?.imageBytes) || observation.process.imageBytes <= 0) errors.push("process imageBytes must be positive");
  if (!/^[a-f0-9]{8}:0x[a-f0-9]{32}$/.test(observation.process?.imageFileId ?? "")) errors.push("process imageFileId is invalid");
  if (expected.imagePath && normalizeWindowsPath(observation.process?.imagePath) !== normalizeWindowsPath(expected.imagePath)) {
    errors.push("process imagePath does not match");
  }
  if (expected.imageSha256 && observation.process?.imageSha256 !== expected.imageSha256.toLowerCase()) {
    errors.push("process imageSha256 does not match");
  }
  if (observation.listener?.address !== "127.0.0.1") errors.push("listener must bind exact IPv4 loopback");
  if (observation.listener?.port !== expected.port) errors.push("listener port does not match");
  if (observation.listener?.owningPid !== expected.processId) errors.push("listener owner does not match the candidate PID");
  return errors;
}

export function validateReleaseSurfaceWindowsRuntimeContinuity(
  attested: ReleaseSurfaceWindowsNativeRuntime,
  observed: ReleaseSurfaceWindowsNativeRuntime,
): string[] {
  const errors = validateReleaseSurfaceWindowsRuntimeBinding(
    toReleaseSurfaceWindowsNativeBinding(attested),
    observed,
  );
  if (Date.parse(observed.observedAt) < Date.parse(attested.observedAt)) {
    errors.push("Windows runtime observation predates the candidate attestation observation");
  }
  return errors;
}

export function toReleaseSurfaceWindowsNativeBinding(
  observation: ReleaseSurfaceWindowsNativeRuntime,
): ReleaseSurfaceWindowsNativeBinding {
  return {
    schema: RELEASE_SURFACE_WINDOWS_NATIVE_BINDING_SCHEMA,
    process: { ...observation.process },
    listener: { ...observation.listener },
  };
}

export function validateReleaseSurfaceWindowsRuntimeBinding(
  binding: ReleaseSurfaceWindowsNativeBinding,
  observed?: ReleaseSurfaceWindowsNativeRuntime,
): string[] {
  const errors: string[] = [];
  if (binding?.schema !== RELEASE_SURFACE_WINDOWS_NATIVE_BINDING_SCHEMA) {
    errors.push(`Windows runtime binding schema must be ${RELEASE_SURFACE_WINDOWS_NATIVE_BINDING_SCHEMA}`);
  }
  if (!Number.isSafeInteger(binding?.process?.pid) || binding.process.pid <= 0) errors.push("Windows runtime binding PID must be positive");
  if (!Number.isFinite(Date.parse(binding?.process?.startId))) errors.push("Windows runtime binding startId must be a valid ISO timestamp");
  if (!binding?.process?.imagePath?.trim()) errors.push("Windows runtime binding imagePath is required");
  if (!/^[a-f0-9]{64}$/.test(binding?.process?.imageSha256 ?? "")) errors.push("Windows runtime binding imageSha256 is invalid");
  if (!Number.isSafeInteger(binding?.process?.imageBytes) || binding.process.imageBytes <= 0) errors.push("Windows runtime binding imageBytes must be positive");
  if (!/^[a-f0-9]{8}:0x[a-f0-9]{32}$/.test(binding?.process?.imageFileId ?? "")) errors.push("Windows runtime binding imageFileId is invalid");
  if (binding?.listener?.address !== "127.0.0.1") errors.push("Windows runtime binding listener must use exact IPv4 loopback");
  if (!Number.isSafeInteger(binding?.listener?.port) || binding.listener.port <= 0 || binding.listener.port > 65535) {
    errors.push("Windows runtime binding listener port is invalid");
  }
  if (binding?.listener?.owningPid !== binding?.process?.pid) errors.push("Windows runtime binding listener owner does not match its PID");
  if (observed) {
    const actual = toReleaseSurfaceWindowsNativeBinding(observed);
    if (JSON.stringify(actual) !== JSON.stringify(binding)) {
      errors.push("Windows runtime binding changed after candidate attestation");
    }
  }
  return errors;
}

export function validateReleaseSurfaceWindowsObservationWindow(
  observedAt: string,
  enclosingObservedAt: string,
  label: string,
  options?: { clockSkewMs?: number; maxAgeMs?: number },
): string[] {
  const observed = Date.parse(observedAt);
  const enclosing = Date.parse(enclosingObservedAt);
  if (!Number.isFinite(observed) || !Number.isFinite(enclosing)) {
    return [`${label} timestamps must be valid ISO timestamps`];
  }
  const clockSkewMs = options?.clockSkewMs ?? RELEASE_SURFACE_WINDOWS_CLOCK_SKEW_MS;
  const maxAgeMs = options?.maxAgeMs ?? RELEASE_SURFACE_WINDOWS_OBSERVATION_MAX_AGE_MS;
  const errors: string[] = [];
  if (observed > enclosing + clockSkewMs) errors.push(`${label} exceeds the Windows/runner clock-skew allowance`);
  if (enclosing - observed > maxAgeMs + clockSkewMs) errors.push(`${label} is stale for its enclosing evidence`);
  return errors;
}

export function validateReleaseSurfaceWindowsProbeOrder(input: {
  attestedAt: string;
  beforeAt: string;
  afterAt: string;
}): string[] {
  const attested = Date.parse(input.attestedAt);
  const before = Date.parse(input.beforeAt);
  const after = Date.parse(input.afterAt);
  if (![attested, before, after].every(Number.isFinite)) {
    return ["Windows native attestation and probe timestamps must be valid ISO timestamps"];
  }
  const errors: string[] = [];
  if (before < attested) errors.push("Windows before-driver native observation predates candidate attestation");
  if (after < before) errors.push("Windows after-driver native observation predates before-driver observation");
  return errors;
}

function windowsReadablePath(path: string): string {
  if (process.platform === "win32") return path;
  const result = spawnSync("wslpath", ["-w", path], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(`unable to map PowerShell script path ${path}`);
  return result.stdout.trim();
}

function resolveWindowsOrchestrator(): "native" | "wsl" {
  if (process.platform === "win32") return "native";
  if (process.env.WSL_INTEROP?.trim()) return "wsl";
  throw new Error("Windows native runtime collection requires native Windows or WSL interop");
}

function normalizeWindowsPath(value: string | undefined): string {
  return (value ?? "").replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
}
