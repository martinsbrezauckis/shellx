import type {
  ConnectionPreset,
  ConnectionProviderCapabilitySnapshot,
  ConnectionProviderScanEntry,
  ConnectionProviderScanStatus,
} from "../components/ConnectionPicker";

export const CONNECTION_PROVIDER_CAPABILITY_SCHEMA = "shellx.provider-capability-snapshot.v2";
export const CONNECTION_PROVIDER_CAPABILITY_TTL_MS = 60_000;
const MAX_CLOCK_SKEW_MS = 5_000;
const SUPPORTED_PROVIDER_IDS = ["grok", "codex-cli", "claude-code", "antigravity-cli"] as const;
const inFlightScans = new Map<string, Promise<ConnectionProviderCapabilitySnapshot>>();
const LIVE_STATUSES = new Set<ConnectionProviderScanStatus>([
  "ready",
  "missing",
  "versionFailed",
  "identityFailed",
  "targetUnavailable",
  "authNeeded",
  "canaryFailed",
]);

export async function scanConnectionProviderCapabilities(
  preset: ConnectionPreset,
): Promise<ConnectionProviderCapabilitySnapshot> {
  const requestKey = connectionProviderScanRequestKey(preset);
  const existing = inFlightScans.get(requestKey);
  if (existing) return existing;

  const request = import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke<ConnectionProviderCapabilitySnapshot>("connection_provider_scan", { preset }))
    .then((snapshot) => {
      assertConnectionProviderCapabilitySnapshot(snapshot, preset);
      return snapshot;
    });
  inFlightScans.set(requestKey, request);
  try {
    return await request;
  } finally {
    if (inFlightScans.get(requestKey) === request) inFlightScans.delete(requestKey);
  }
}

export function connectionProviderScanRequestKey(preset: ConnectionPreset): string {
  const transport = preset.transport;
  switch (transport.kind) {
    case "local":
      return JSON.stringify(["local", transport.grokPath?.trim() ?? ""]);
    case "wsl":
      return JSON.stringify([
        "wsl",
        transport.distro.trim().toLowerCase(),
        transport.grokPath.trim(),
      ]);
    case "ssh":
      return JSON.stringify([
        "ssh",
        normalizeSshTargetDestination(transport.host),
        transport.port ?? 22,
        transport.remoteRuntime ?? "posix",
        transport.wslDistro?.trim().toLowerCase() ?? "",
        transport.remoteGrokPath.trim(),
        transport.keyVaultRef?.trim() ?? "",
      ]);
    case "ws_direct":
      return JSON.stringify(["ws_direct", transport.url.trim()]);
    case "ws_tunnel":
      return JSON.stringify(["ws_tunnel", transport.url.trim()]);
    case "tailscale":
      return JSON.stringify(["tailscale", transport.tailnetHost.trim().toLowerCase(), transport.port ?? 0]);
  }
}

export function assertConnectionProviderCapabilitySnapshot(
  snapshot: ConnectionProviderCapabilitySnapshot,
  preset: ConnectionPreset,
  nowMs = Date.now(),
): void {
  if (!snapshot || snapshot.schemaVersion !== CONNECTION_PROVIDER_CAPABILITY_SCHEMA) {
    throw new Error("provider capability snapshot schema mismatch");
  }
  if (!Number.isFinite(snapshot.generatedAtMs) || !Number.isFinite(snapshot.freshUntilMs)) {
    throw new Error("provider capability snapshot timestamps are invalid");
  }
  if (snapshot.generatedAtMs > nowMs + MAX_CLOCK_SKEW_MS) {
    throw new Error("provider capability snapshot was generated in the future");
  }
  if (
    snapshot.freshUntilMs - snapshot.generatedAtMs !== CONNECTION_PROVIDER_CAPABILITY_TTL_MS ||
    snapshot.freshUntilMs < nowMs
  ) {
    throw new Error("provider capability snapshot is stale");
  }
  assertTargetMatchesPreset(snapshot, preset);
  if (!Array.isArray(snapshot.providers)) {
    throw new Error("provider capability snapshot providers are missing");
  }
  const seen = new Set<string>();
  for (const provider of snapshot.providers) {
    if (!SUPPORTED_PROVIDER_IDS.includes(provider.providerId as typeof SUPPORTED_PROVIDER_IDS[number])) {
      throw new Error(`provider capability snapshot contains unsupported provider ${provider.providerId}`);
    }
    if (seen.has(provider.providerId)) {
      throw new Error(`provider capability snapshot duplicates ${provider.providerId}`);
    }
    seen.add(provider.providerId);
    assertProviderRow(provider, snapshot.target.key, snapshot.generatedAtMs);
  }
  const missing = SUPPORTED_PROVIDER_IDS.filter((providerId) => !seen.has(providerId));
  if (missing.length > 0) {
    throw new Error(`provider capability snapshot omitted ${missing.join(", ")}`);
  }
}

export function providerScanStatus(entry: ConnectionProviderScanEntry): ConnectionProviderScanStatus {
  if (entry.status && entry.status !== "unknown") return entry.status;
  if (!entry.canRun) return "missing";
  return entry.version ? "ready" : "versionFailed";
}

function assertTargetMatchesPreset(
  snapshot: ConnectionProviderCapabilitySnapshot,
  preset: ConnectionPreset,
): void {
  const target = snapshot.target;
  if (!target || !target.key?.trim() || !target.label?.trim()) {
    throw new Error("provider capability snapshot target identity is missing");
  }
  if (target.key.includes("|key=") || target.key.includes("ssh/")) {
    throw new Error("provider capability snapshot target key exposes a Vault reference");
  }
  const transport = preset.transport;
  if (transport.kind === "local") {
    const platform = target.key.startsWith("local:") ? target.key.slice("local:".length) : "";
    const expectedRuntime = platform === "windows" ? "windows" : "posix";
    if (
      target.transport !== "local" ||
      !platform ||
      target.runtime !== expectedRuntime
    ) {
      throw new Error(`provider capability snapshot target mismatch: expected local, got ${target.key}`);
    }
    return;
  }
  if (transport.kind === "wsl") {
    const expected = `wsl:${transport.distro.trim().toLowerCase()}`;
    if (target.transport !== "wsl" || target.runtime !== "posix" || target.key !== expected) {
      throw new Error(`provider capability snapshot target mismatch: expected ${expected}, got ${target.key}`);
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
      throw new Error(`provider capability snapshot target mismatch: expected ${expected}, got ${target.key}`);
    }
    return;
  }
  throw new Error(`provider capability snapshots do not support ${transport.kind}`);
}

function normalizeSshTargetDestination(destination: string): string {
  const trimmed = destination.trim();
  const separator = trimmed.lastIndexOf("@");
  if (separator < 0) return trimmed.toLowerCase();
  return `${trimmed.slice(0, separator + 1)}${trimmed.slice(separator + 1).toLowerCase()}`;
}

function assertProviderRow(
  entry: ConnectionProviderScanEntry,
  targetKey: string,
  generatedAtMs: number,
): void {
  const status = entry.status;
  if (!status || !LIVE_STATUSES.has(status)) {
    throw new Error(`provider capability row ${entry.providerId} has invalid status ${String(status)}`);
  }
  if (entry.targetKey !== targetKey) {
    throw new Error(`provider capability row ${entry.providerId} belongs to a different target`);
  }
  if (
    !Number.isFinite(entry.checkedAtMs)
    || entry.checkedAtMs > generatedAtMs + MAX_CLOCK_SKEW_MS
    || entry.checkedAtMs < generatedAtMs - CONNECTION_PROVIDER_CAPABILITY_TTL_MS
  ) {
    throw new Error(`provider capability row ${entry.providerId} has invalid checkedAtMs`);
  }
  if (status === "ready" && (
    !entry.canRun || !entry.binary || !entry.version
    || !/^[a-f0-9]{64}$/i.test(entry.binarySha256 ?? "")
    || !Number.isSafeInteger(entry.binaryBytes) || Number(entry.binaryBytes) <= 0
  )) {
    throw new Error(`ready provider capability row ${entry.providerId} lacks exact binary, version, hash, or size evidence`);
  }
  if (status === "missing" && (
    entry.canRun || entry.binary !== undefined || entry.version !== undefined
    || entry.binarySha256 !== undefined || entry.binaryBytes !== undefined
  )) {
    throw new Error(`missing provider capability row ${entry.providerId} claims a resolved binary`);
  }
  if (status === "versionFailed" && (
    !entry.canRun || !entry.binary || entry.version !== undefined
    || entry.binarySha256 !== undefined || entry.binaryBytes !== undefined
  )) {
    throw new Error(`versionFailed provider capability row ${entry.providerId} is inconsistent`);
  }
  if (status === "identityFailed" && (
    !entry.canRun || !entry.binary || !entry.version
    || entry.binarySha256 !== undefined || entry.binaryBytes !== undefined
  )) {
    throw new Error(`identityFailed provider capability row ${entry.providerId} is inconsistent`);
  }
  if (
    (status === "targetUnavailable" || status === "authNeeded" || status === "canaryFailed") &&
    (entry.canRun || entry.binary !== undefined || entry.version !== undefined
      || entry.binarySha256 !== undefined || entry.binaryBytes !== undefined)
  ) {
    throw new Error(`${status} provider capability row ${entry.providerId} claims runnable evidence`);
  }
}
