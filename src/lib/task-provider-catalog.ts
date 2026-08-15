import type {
  ConnectionPreset,
  ConnectionProviderCapabilityTarget,
  ConnectionProviderScanStatus,
} from "../components/ConnectionPicker";
import type { AgentId } from "./agent-selection";

export const TASK_PROVIDER_CATALOG_SCHEMA = "shellx.task-provider-catalog.v1";
export const TASK_PROVIDER_CATALOG_TTL_MS = 60_000;

const MAX_CLOCK_SKEW_MS = 5_000;
const PROVIDER_IDS = ["grok", "codex-cli", "claude-code", "antigravity-cli"] as const;
const LIVE_STATUSES = new Set<ConnectionProviderScanStatus>([
  "ready",
  "missing",
  "versionFailed",
  "identityFailed",
  "targetUnavailable",
  "authNeeded",
  "canaryFailed",
]);

export interface TaskProviderCatalog {
  schemaVersion: "shellx.task-provider-catalog.v1";
  snapshotId: string;
  generatedAtMs: number;
  freshUntilMs: number;
  target: ConnectionProviderCapabilityTarget;
  providers: TaskProviderCatalogProvider[];
}

export interface TaskProviderCatalogProvider {
  providerId: AgentId;
  label: string;
  availability: TaskProviderAvailability;
  capabilityGuidance: TaskProviderCapabilityGuidance[];
  models: TaskProviderCatalogModel[];
  defaultModelMode: "providerDefault";
}

export interface TaskProviderAvailability {
  status: ConnectionProviderScanStatus;
  canRun: boolean;
  version?: string;
  detail: string;
  checkedAtMs: number;
}

export interface TaskProviderCapabilityGuidance {
  id: string;
  label: string;
  level: string;
  sourceCardIds: string[];
}

/** Reserved for a future provider-native structured model inventory. */
export interface TaskProviderCatalogModel {
  id: string;
  label: string;
  source: string;
  verifiedAtMs?: number;
}

/**
 * Query the Task catalogue projection. The backend obtains a new exact-target provider scan;
 * this client refuses a response whose target or freshness does not match the requested preset.
 */
export async function scanTaskProviderCatalog(
  preset: ConnectionPreset,
): Promise<TaskProviderCatalog> {
  const { invoke } = await import("@tauri-apps/api/core");
  const catalogue = await invoke<TaskProviderCatalog>("task_provider_catalog", { preset });
  assertTaskProviderCatalog(catalogue, preset);
  return catalogue;
}

export function assertTaskProviderCatalog(
  catalogue: TaskProviderCatalog,
  preset: ConnectionPreset,
  nowMs = Date.now(),
): void {
  if (!catalogue || catalogue.schemaVersion !== TASK_PROVIDER_CATALOG_SCHEMA) {
    throw new Error("task provider catalogue schema mismatch");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(catalogue.snapshotId)) {
    throw new Error("task provider catalogue snapshot identity is invalid");
  }
  if (!Number.isFinite(catalogue.generatedAtMs) || !Number.isFinite(catalogue.freshUntilMs)) {
    throw new Error("task provider catalogue timestamps are invalid");
  }
  if (catalogue.generatedAtMs > nowMs + MAX_CLOCK_SKEW_MS) {
    throw new Error("task provider catalogue was generated in the future");
  }
  if (
    catalogue.freshUntilMs - catalogue.generatedAtMs !== TASK_PROVIDER_CATALOG_TTL_MS
    || catalogue.freshUntilMs < nowMs
  ) {
    throw new Error("task provider catalogue is stale");
  }
  assertTargetMatchesPreset(catalogue.target, preset);
  if (!Array.isArray(catalogue.providers)) {
    throw new Error("task provider catalogue providers are missing");
  }

  const seen = new Set<string>();
  for (const provider of catalogue.providers) {
    if (!PROVIDER_IDS.includes(provider.providerId as typeof PROVIDER_IDS[number])) {
      throw new Error(`task provider catalogue contains unsupported provider ${provider.providerId}`);
    }
    if (seen.has(provider.providerId)) {
      throw new Error(`task provider catalogue duplicates ${provider.providerId}`);
    }
    seen.add(provider.providerId);
    assertProvider(provider, catalogue.generatedAtMs);
  }
  const missing = PROVIDER_IDS.filter((providerId) => !seen.has(providerId));
  if (missing.length > 0) {
    throw new Error(`task provider catalogue omitted ${missing.join(", ")}`);
  }
}

function assertTargetMatchesPreset(
  target: ConnectionProviderCapabilityTarget,
  preset: ConnectionPreset,
): void {
  if (!target || !target.key?.trim() || !target.label?.trim()) {
    throw new Error("task provider catalogue target identity is missing");
  }
  if (target.key.includes("|key=") || target.key.includes("ssh/")) {
    throw new Error("task provider catalogue target key exposes a Vault reference");
  }
  const transport = preset.transport;
  if (transport.kind === "local") {
    const platform = target.key.startsWith("local:") ? target.key.slice("local:".length) : "";
    const expectedRuntime = platform === "windows" ? "windows" : "posix";
    if (target.transport !== "local" || !platform || target.runtime !== expectedRuntime) {
      throw new Error(`task provider catalogue target mismatch: expected local, got ${target.key}`);
    }
    return;
  }
  if (transport.kind === "wsl") {
    const expected = `wsl:${transport.distro.trim().toLowerCase()}`;
    if (target.transport !== "wsl" || target.runtime !== "posix" || target.key !== expected) {
      throw new Error(`task provider catalogue target mismatch: expected ${expected}, got ${target.key}`);
    }
    return;
  }
  if (transport.kind === "ssh") {
    const runtime = transport.remoteRuntime ?? "posix";
    const port = transport.port ?? 22;
    let expected = `ssh:${runtime}:${normalizeSshTargetDestination(transport.host)}:${port}`;
    if (runtime === "windows_wsl") {
      expected += `:wsl=${(transport.wslDistro ?? "").trim().toLowerCase()}`;
    }
    if (target.transport !== "ssh" || target.runtime !== runtime || target.key !== expected) {
      throw new Error(`task provider catalogue target mismatch: expected ${expected}, got ${target.key}`);
    }
    return;
  }
  throw new Error(`task provider catalogues do not support ${transport.kind}`);
}

function assertProvider(provider: TaskProviderCatalogProvider, generatedAtMs: number): void {
  if (!provider.label?.trim()) {
    throw new Error(`task provider catalogue provider ${provider.providerId} has no label`);
  }
  const availability = provider.availability;
  if (!availability || !LIVE_STATUSES.has(availability.status)) {
    throw new Error(`task provider catalogue provider ${provider.providerId} has invalid availability`);
  }
  if (typeof availability.canRun !== "boolean" || typeof availability.detail !== "string") {
    throw new Error(`task provider catalogue provider ${provider.providerId} has invalid availability data`);
  }
  if (
    !Number.isFinite(availability.checkedAtMs)
    || availability.checkedAtMs > generatedAtMs + MAX_CLOCK_SKEW_MS
    || availability.checkedAtMs < generatedAtMs - TASK_PROVIDER_CATALOG_TTL_MS
  ) {
    throw new Error(`task provider catalogue provider ${provider.providerId} has invalid checkedAtMs`);
  }
  if (availability.status === "ready" && (!availability.canRun || !availability.version?.trim())) {
    throw new Error(`ready task provider catalogue provider ${provider.providerId} lacks version evidence`);
  }
  if (provider.defaultModelMode !== "providerDefault") {
    throw new Error(`task provider catalogue provider ${provider.providerId} has unsupported model mode`);
  }
  if (!Array.isArray(provider.models) || provider.models.length > 0) {
    throw new Error(`task provider catalogue provider ${provider.providerId} claims an unverified model inventory`);
  }
  if (!Array.isArray(provider.capabilityGuidance)) {
    throw new Error(`task provider catalogue provider ${provider.providerId} has invalid capability guidance`);
  }
  for (const guidance of provider.capabilityGuidance) {
    if (
      !guidance.id?.trim() || !guidance.label?.trim() || !guidance.level?.trim()
      || !Array.isArray(guidance.sourceCardIds) || guidance.sourceCardIds.length === 0
    ) {
      throw new Error(`task provider catalogue provider ${provider.providerId} has invalid capability guidance`);
    }
  }
}

function normalizeSshTargetDestination(destination: string): string {
  const trimmed = destination.trim();
  const separator = trimmed.lastIndexOf("@");
  if (separator < 0) return trimmed.toLowerCase();
  return `${trimmed.slice(0, separator + 1)}${trimmed.slice(separator + 1).toLowerCase()}`;
}
