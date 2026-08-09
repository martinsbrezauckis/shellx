import { readFileSync } from "node:fs";
import type { FinalSurfaceContract } from "./release-surface-receipts";
import type { ReleasePlatform } from "./release-surface-inventory";

export const RELEASE_SURFACE_SCENARIO_REPORT_SCHEMA = "shellx/release-surface-scenario-report@4";
export const RELEASE_SURFACE_NORMALIZED_PROVIDER_EVENT_SCHEMA = "shellx/provider-session-event@1";
export const RELEASE_SURFACE_PROVIDER_ROUTE_CANARY_ID = "shellx/provider-route-canary@1";

const PROVIDER_STREAM_CONTRACTS: Record<string, { protocol: string; streamKind: string }> = {
  grok: { protocol: "acp", streamKind: "jsonl" },
  "codex-cli": { protocol: "codex-jsonl", streamKind: "jsonl" },
  "claude-code": { protocol: "claude-stream-json", streamKind: "stream-json" },
  "antigravity-cli": { protocol: "antigravity-stream-json", streamKind: "stream-json" },
};

export type ReleaseSurfaceHostOs = "windows" | "macos" | "linux";
export type ReleaseSurfaceRuntimeKind = "windows-native" | "posix-native" | "wsl";
export type ReleaseSurfaceShellKind = "powershell" | "posix-shell" | "wsl-bash";

export interface ReleaseSurfaceEvidenceFileIdentity {
  basename: string;
  sha256: string;
  bytes: number;
}

export interface ReleaseSurfaceProviderRoute {
  id: string;
  transportId: string;
  providerId: string;
  status: "pass" | "fail";
  evidenceMode: "identity-only" | "live-canary";
  appHostPlatform: ReleasePlatform;
  target: {
    transport: "local" | "wsl" | "ssh";
    hostOs: ReleaseSurfaceHostOs;
    runtimeKind: ReleaseSurfaceRuntimeKind;
    runtimeOs: ReleaseSurfaceHostOs;
    shellKind: ReleaseSurfaceShellKind;
    hostFingerprintSha256: string;
    wslDistro?: string;
  };
  provider: {
    executable: string;
    executableSha256: string;
    executableBytes: number;
    version: string;
  };
  stream: {
    canaryId: typeof RELEASE_SURFACE_PROVIDER_ROUTE_CANARY_ID | null;
    nativeProtocol: string;
    nativeStreamKind: string;
    normalizedSchema: typeof RELEASE_SURFACE_NORMALIZED_PROVIDER_EVENT_SCHEMA;
    eventCount: number;
    observedEventKinds: string[];
    finalState: "not-run" | "completed" | "failed";
    canaryMatched: boolean;
    gapCount: number;
    parseErrorCount: number;
  };
  cleanup: "pass" | "fail";
  startedAt: string;
  completedAt: string;
  observed: string;
  evidence: ReleaseSurfaceEvidenceFileIdentity;
}

export interface ReleaseSurfaceScenarioReport {
  schema: typeof RELEASE_SURFACE_SCENARIO_REPORT_SCHEMA;
  mode: "final-frozen-candidate";
  platform: ReleasePlatform;
  sourceCommit: string;
  version: string;
  inventoryDigest: string;
  artifactSha256: string;
  startedAt: string;
  completedAt: string;
  providerRoutes: ReleaseSurfaceProviderRoute[];
  health: {
    startup: "pass" | "fail";
    shutdown: "pass" | "fail";
    brokenLinks: number;
    unexpectedConsoleErrors: number;
    observed: string;
    evidence: ReleaseSurfaceEvidenceFileIdentity;
  };
}

export function loadReleaseSurfaceScenarioReport(path: string): ReleaseSurfaceScenarioReport {
  return JSON.parse(readFileSync(path, "utf8")) as ReleaseSurfaceScenarioReport;
}

export function releaseSurfaceProviderRouteId(providerId: string, transportId: string): string {
  return `${providerId}::${transportId}`;
}

export function expectedReleaseSurfaceProviderRouteIds(
  contract: FinalSurfaceContract,
  platform: ReleasePlatform,
): string[] {
  const platformContract = contract.platforms[platform];
  if (!platformContract) return [];
  return platformContract.requiredProviderRoutes
    .map(({ providerId, transportId }) => releaseSurfaceProviderRouteId(providerId, transportId))
    .sort();
}

export function validateReleaseSurfaceScenarioReport(input: {
  report: ReleaseSurfaceScenarioReport;
  contract: FinalSurfaceContract;
  platform: ReleasePlatform;
  sourceCommit: string;
  version: string;
  inventoryDigest: string;
  artifactSha256: string;
}): string[] {
  const { report, contract, platform, sourceCommit, version, inventoryDigest, artifactSha256 } = input;
  const errors: string[] = [];
  if (report.schema !== RELEASE_SURFACE_SCENARIO_REPORT_SCHEMA) errors.push(`scenario schema must be ${RELEASE_SURFACE_SCENARIO_REPORT_SCHEMA}`);
  if (report.mode !== "final-frozen-candidate") errors.push("scenario mode must be final-frozen-candidate");
  for (const [field, expected, actual] of [
    ["platform", platform, report.platform],
    ["sourceCommit", sourceCommit, report.sourceCommit],
    ["version", version, report.version],
    ["inventoryDigest", inventoryDigest, report.inventoryDigest],
    ["artifactSha256", artifactSha256, report.artifactSha256],
  ] as const) {
    if (actual !== expected) errors.push(`scenario ${field} must match the exact driver run`);
  }
  if (!validIsoRange(report.startedAt, report.completedAt)) errors.push("scenario timestamps must be valid and ordered");

  const platformContract = contract.platforms[platform];
  if (!platformContract) {
    errors.push(`scenario platform ${platform} is outside the final contract`);
    return errors;
  }
  if (contract.providerRoutePolicy !== "exact-identity-routes-with-minimal-live-canaries") {
    errors.push("scenario contract must require exact route identities and coverage-minimal live canaries");
  }
  validateProviderRoutes(report.providerRoutes, contract, platform, report.startedAt, report.completedAt, errors);
  if (report.health?.startup !== "pass") errors.push("scenario startup health must pass");
  if (report.health?.shutdown !== "pass") errors.push("scenario shutdown health must pass");
  if (report.health?.brokenLinks !== 0) errors.push("scenario brokenLinks must be zero");
  if (report.health?.unexpectedConsoleErrors !== 0) errors.push("scenario unexpectedConsoleErrors must be zero");
  if (!report.health?.observed?.trim()) errors.push("scenario health must describe the observed checks");
  if (!report.health?.evidence?.basename?.trim()
    || report.health.evidence.basename.includes("/") || report.health.evidence.basename.includes("\\")) {
    errors.push("scenario health evidence basename is invalid");
  }
  if (!isSha256(report.health?.evidence?.sha256)) errors.push("scenario health evidence sha256 must be 64 hex characters");
  if (!Number.isSafeInteger(report.health?.evidence?.bytes) || report.health.evidence.bytes <= 0) {
    errors.push("scenario health evidence bytes must be a positive integer");
  }
  return errors;
}

function validateProviderRoutes(
  routes: ReleaseSurfaceProviderRoute[],
  contract: FinalSurfaceContract,
  platform: ReleasePlatform,
  reportStartedAt: string,
  reportCompletedAt: string,
  errors: string[],
): void {
  if (!Array.isArray(routes)) {
    errors.push("scenario providerRoutes must be an array");
    return;
  }
  const byId = new Map<string, ReleaseSurfaceProviderRoute>();
  for (const route of routes) {
    if (!route?.id?.trim()) {
      errors.push("scenario provider route id is missing");
      continue;
    }
    if (byId.has(route.id)) errors.push(`scenario provider route ${route.id} appears more than once`);
    else byId.set(route.id, route);
    validateProviderRoute(route, contract, platform, reportStartedAt, reportCompletedAt, errors);
  }
  const expectedIds = expectedReleaseSurfaceProviderRouteIds(contract, platform);
  for (const id of expectedIds) {
    if (!byId.has(id)) errors.push(`scenario required provider route ${id} is missing`);
  }
  for (const id of byId.keys()) {
    if (!expectedIds.includes(id)) errors.push(`scenario provider route ${id} is not declared in the final contract`);
  }
}

function validateProviderRoute(
  route: ReleaseSurfaceProviderRoute,
  contract: FinalSurfaceContract,
  platform: ReleasePlatform,
  reportStartedAt: string,
  reportCompletedAt: string,
  errors: string[],
): void {
  const label = `scenario provider route ${route.id}`;
  const expectedId = releaseSurfaceProviderRouteId(route.providerId, route.transportId);
  if (route.id !== expectedId) errors.push(`${label} id must be ${expectedId}`);
  if (!contract.requiredProviders.includes(route.providerId)) errors.push(`${label} names undeclared provider ${route.providerId}`);
  if (!contract.platforms[platform]?.requiredTransports.includes(route.transportId)) errors.push(`${label} names undeclared transport ${route.transportId}`);
  if (route.appHostPlatform !== platform) errors.push(`${label} appHostPlatform must match the installed candidate platform`);
  if (route.status !== "pass") errors.push(`${label} must pass`);
  const liveIds = new Set((contract.platforms[platform]?.requiredLiveProviderRoutes ?? [])
    .map(({ providerId, transportId }) => releaseSurfaceProviderRouteId(providerId, transportId)));
  const expectedEvidenceMode = liveIds.has(route.id) ? "live-canary" : "identity-only";
  if (route.evidenceMode !== expectedEvidenceMode) {
    errors.push(`${label} must use ${expectedEvidenceMode} evidence`);
  }
  if (route.cleanup !== "pass") errors.push(`${label} cleanup must pass`);
  if (!validIsoRange(route.startedAt, route.completedAt)) errors.push(`${label} timestamps must be valid and ordered`);
  if (Date.parse(route.startedAt) < Date.parse(reportStartedAt) || Date.parse(route.completedAt) > Date.parse(reportCompletedAt)) {
    errors.push(`${label} timestamps must stay inside the scenario interval`);
  }
  if (!route.observed?.trim()) errors.push(`${label} must describe the observed result`);
  if (!route.evidence?.basename?.trim() || route.evidence.basename.includes("/") || route.evidence.basename.includes("\\")) {
    errors.push(`${label} evidence basename is invalid`);
  }
  if (!isSha256(route.evidence?.sha256)) errors.push(`${label} evidence sha256 must be 64 hex characters`);
  if (!Number.isSafeInteger(route.evidence?.bytes) || route.evidence.bytes <= 0) {
    errors.push(`${label} evidence bytes must be a positive integer`);
  }
  validateRouteTarget(route, platform, errors);

  const provider = route.provider;
  if (!provider?.executable?.trim()) errors.push(`${label} must record the resolved provider executable`);
  else if (route.target?.runtimeKind === "windows-native") {
    if (!/^(?:[a-z]:\\|\\\\\?\\[a-z]:\\)/i.test(provider.executable)) {
      errors.push(`${label} Windows executable must be an absolute drive path`);
    }
  } else if (!provider.executable.startsWith("/")) {
    errors.push(`${label} POSIX/WSL executable must be an absolute path`);
  }
  if (!isSha256(provider?.executableSha256)) errors.push(`${label} executableSha256 must be 64 hex characters`);
  if (!Number.isSafeInteger(provider?.executableBytes) || provider.executableBytes <= 0) errors.push(`${label} executableBytes must be a positive integer`);
  if (!provider?.version?.trim()) errors.push(`${label} must record the tested provider version`);

  const stream = route.stream;
  const streamContract = PROVIDER_STREAM_CONTRACTS[route.providerId];
  if (!streamContract || stream?.nativeProtocol !== streamContract.protocol) errors.push(`${label} provider-native protocol is invalid`);
  if (!streamContract || stream?.nativeStreamKind !== streamContract.streamKind) errors.push(`${label} provider-native stream kind is invalid`);
  if (stream?.normalizedSchema !== RELEASE_SURFACE_NORMALIZED_PROVIDER_EVENT_SCHEMA) errors.push(`${label} normalized event schema is invalid`);
  if (route.evidenceMode === "identity-only") {
    if (stream?.canaryId !== null || stream?.eventCount !== 0 || stream?.observedEventKinds?.length !== 0
      || stream?.finalState !== "not-run" || stream?.canaryMatched !== false) {
      errors.push(`${label} identity-only evidence must not claim a live provider stream`);
    }
  } else {
    if (stream?.canaryId !== RELEASE_SURFACE_PROVIDER_ROUTE_CANARY_ID) errors.push(`${label} canary id is invalid`);
    if (!Number.isSafeInteger(stream?.eventCount) || stream.eventCount < 3) errors.push(`${label} must record start, assistant text, and completion events`);
    if (!Array.isArray(stream?.observedEventKinds) || stream.observedEventKinds.length === 0) errors.push(`${label} observed event kinds are missing`);
    else {
      if (new Set(stream.observedEventKinds).size !== stream.observedEventKinds.length) errors.push(`${label} observed event kinds must be unique`);
      if (JSON.stringify(stream.observedEventKinds) !== JSON.stringify(["started", "text", "completed"])) {
        errors.push(`${label} normalized stream must contain only started, text, and completed lifecycle events`);
      }
    }
    if (stream?.finalState !== "completed") errors.push(`${label} normalized stream must complete`);
    if (stream?.canaryMatched !== true) errors.push(`${label} normalized stream must match its bounded canary`);
  }
  if (stream?.gapCount !== 0) errors.push(`${label} normalized stream must contain zero sequence gaps`);
  if (stream?.parseErrorCount !== 0) errors.push(`${label} normalized stream must contain zero parse errors`);
}

function validateRouteTarget(
  route: ReleaseSurfaceProviderRoute,
  platform: ReleasePlatform,
  errors: string[],
): void {
  const label = `scenario provider route ${route.id}`;
  const target = route.target;
  if (!target) {
    errors.push(`${label} target is missing`);
    return;
  }
  if (!isSha256(target.hostFingerprintSha256)) errors.push(`${label} host fingerprint must be a SHA-256 digest`);
  const expectedLocalOs: ReleaseSurfaceHostOs = platform === "windows-installed"
    ? "windows"
    : platform === "macos-installed" ? "macos" : "linux";
  const noWsl = () => {
    if (target.wslDistro !== undefined) errors.push(`${label} must not record a WSL distro`);
  };
  switch (route.transportId) {
    case "local-native": {
      const expectedRuntime = expectedLocalOs === "windows" ? "windows-native" : "posix-native";
      if (target.transport !== "local" || target.hostOs !== expectedLocalOs
        || target.runtimeKind !== expectedRuntime || target.runtimeOs !== expectedLocalOs
        || target.shellKind !== (expectedLocalOs === "windows" ? "powershell" : "posix-shell")) {
        errors.push(`${label} does not describe the installed platform's native local runtime`);
      }
      noWsl();
      break;
    }
    case "local-wsl":
      if (platform !== "windows-installed" || target.transport !== "wsl" || target.hostOs !== "windows"
        || target.runtimeKind !== "wsl" || target.runtimeOs !== "linux" || target.shellKind !== "wsl-bash"
        || !target.wslDistro?.trim()) {
        errors.push(`${label} must describe an explicit Linux WSL distro on the local Windows host`);
      }
      break;
    case "ssh-posix-native":
      if (target.transport !== "ssh" || !["linux", "macos"].includes(target.hostOs)
        || target.runtimeKind !== "posix-native" || target.runtimeOs !== target.hostOs
        || target.shellKind !== "posix-shell") {
        errors.push(`${label} must describe a native POSIX SSH destination`);
      }
      noWsl();
      break;
    case "ssh-windows-native":
      if (target.transport !== "ssh" || target.hostOs !== "windows"
        || target.runtimeKind !== "windows-native" || target.runtimeOs !== "windows"
        || target.shellKind !== "powershell") {
        errors.push(`${label} must describe native Windows reached through OpenSSH`);
      }
      noWsl();
      break;
    case "ssh-windows-wsl":
      if (target.transport !== "ssh" || target.hostOs !== "windows"
        || target.runtimeKind !== "wsl" || target.runtimeOs !== "linux" || target.shellKind !== "wsl-bash"
        || !target.wslDistro?.trim()) {
        errors.push(`${label} must describe an explicitly selected Linux WSL distro behind Windows OpenSSH`);
      }
      break;
    default:
      errors.push(`${label} has unknown transport ${route.transportId}`);
  }
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function validIsoRange(startedAt: string, completedAt: string): boolean {
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start;
}
