import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ConnectionPreset } from "../../src/components/ConnectionPicker";
import {
  collectReleaseSurfaceProviderRouteEvidence,
  type CollectReleaseSurfaceProviderRouteInput,
} from "../collect-release-surface-provider-route-evidence";
import type { ReleaseSurfaceCandidateAttestation } from "./release-surface-candidate-attestation";
import type { ReleasePlatform } from "./release-surface-inventory";
import {
  validateReleaseSurfaceProviderRouteEvidence,
} from "./release-surface-provider-route-evidence";
import {
  releaseSurfaceProviderRouteId,
  type ReleaseSurfaceHostOs,
  type ReleaseSurfaceProviderRoute,
} from "./release-surface-scenario-report";
import type { FinalSurfaceContract } from "./release-surface-receipts";

export const RELEASE_SURFACE_PROVIDER_ROUTE_BATCH_PLAN_SCHEMA =
  "shellx/release-surface-provider-route-batch-plan@1";
export const RELEASE_SURFACE_PROVIDER_ROUTE_BATCH_SCHEMA =
  "shellx/release-surface-provider-route-batch@3";

const PROVIDERS = ["grok", "codex-cli", "claude-code", "antigravity-cli"] as const;
type ProviderId = typeof PROVIDERS[number];

export interface ReleaseSurfaceProviderRouteBatchPlanEntry {
  providerId: ProviderId;
  transportId: string;
  cwd: string;
  targetHostOs?: ReleaseSurfaceHostOs;
  preset: ConnectionPreset;
}

export interface ReleaseSurfaceProviderRouteBatchPlan {
  schema: typeof RELEASE_SURFACE_PROVIDER_ROUTE_BATCH_PLAN_SCHEMA;
  platform: ReleasePlatform;
  routes: ReleaseSurfaceProviderRouteBatchPlanEntry[];
}

export interface ReleaseSurfaceProviderRouteBatch {
  schema: typeof RELEASE_SURFACE_PROVIDER_ROUTE_BATCH_SCHEMA;
  mode: "final-frozen-candidate";
  platform: ReleasePlatform;
  sourceCommit: string;
  version: string;
  artifactSha256: string;
  processId: number;
  instanceId: string;
  startedAt: string;
  completedAt: string;
  routes: ReleaseSurfaceProviderRoute[];
}

export interface CollectReleaseSurfaceProviderRouteBatchInput {
  plan: ReleaseSurfaceProviderRouteBatchPlan;
  contract: FinalSurfaceContract;
  candidate: ReleaseSurfaceCandidateAttestation;
  token: string;
  outputDir: string;
  fetchImpl?: typeof fetch;
  collectRoute?: typeof collectReleaseSurfaceProviderRouteEvidence;
  validateEvidence?: typeof validateReleaseSurfaceProviderRouteEvidence;
  now?: () => Date;
}

export function loadReleaseSurfaceProviderRouteBatchPlan(path: string): ReleaseSurfaceProviderRouteBatchPlan {
  const absolute = requireRegularFile(path, "provider route batch plan");
  return JSON.parse(readFileSync(absolute, "utf8")) as ReleaseSurfaceProviderRouteBatchPlan;
}

export function validateReleaseSurfaceProviderRouteBatchPlan(input: {
  plan: ReleaseSurfaceProviderRouteBatchPlan;
  contract: FinalSurfaceContract;
  platform: ReleasePlatform;
}): string[] {
  const { plan, contract, platform } = input;
  const errors: string[] = [];
  if (plan?.schema !== RELEASE_SURFACE_PROVIDER_ROUTE_BATCH_PLAN_SCHEMA) {
    errors.push(`route plan schema must be ${RELEASE_SURFACE_PROVIDER_ROUTE_BATCH_PLAN_SCHEMA}`);
  }
  if (plan && typeof plan === "object") {
    const planExtras = unknownKeys(plan as unknown as Record<string, unknown>, ["schema", "platform", "routes"]);
    if (planExtras.length > 0) errors.push("route plan contains unknown fields");
  }
  if (plan?.platform !== platform) errors.push(`route plan platform must be ${platform}`);
  if (!Array.isArray(plan?.routes)) return [...errors, "route plan routes must be an array"];
  const platformContract = contract.platforms[platform];
  if (!platformContract) return [...errors, `route plan platform ${platform} is outside the final contract`];
  const expected = platformContract.requiredProviderRoutes
    .map(({ providerId, transportId }) => releaseSurfaceProviderRouteId(providerId, transportId))
    .sort();
  const seen = new Set<string>();
  for (const route of plan.routes) {
    const id = releaseSurfaceProviderRouteId(String(route?.providerId ?? ""), String(route?.transportId ?? ""));
    if (route && typeof route === "object") {
      const routeExtras = unknownKeys(route as unknown as Record<string, unknown>, [
        "providerId", "transportId", "cwd", "targetHostOs", "preset",
      ]);
      if (routeExtras.length > 0) errors.push(`${id} contains unknown fields`);
    }
    if (seen.has(id)) errors.push(`route plan contains duplicate ${id}`);
    seen.add(id);
    if (!contract.requiredProviders.includes(route?.providerId)) errors.push(`${id} uses an undeclared provider`);
    if (!platformContract.requiredTransports.includes(route?.transportId)) errors.push(`${id} uses an undeclared transport`);
    if (!route?.cwd?.trim() || route.cwd.length > 4_096 || /[\r\n\0]/.test(route.cwd)) {
      errors.push(`${id} requires a bounded single-line cwd`);
    }
    validatePreset(route, platform, id, errors);
  }
  const actual = [...seen].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    errors.push("route plan must contain the exact declared provider-transport routes once");
  }
  return errors;
}

export async function collectReleaseSurfaceProviderRouteBatch(
  input: CollectReleaseSurfaceProviderRouteBatchInput,
): Promise<{ batch: ReleaseSurfaceProviderRouteBatch; manifestPath: string }> {
  const errors = validateReleaseSurfaceProviderRouteBatchPlan({
    plan: input.plan,
    contract: input.contract,
    platform: input.candidate.platform,
  });
  if (errors.length > 0) throw new Error(`invalid provider route batch plan: ${errors.join("; ")}`);
  if (input.token.length < 32) throw new Error("provider route batch token is invalid");
  const outputDir = requireRegularDirectory(input.outputDir, "provider route output directory");
  const manifestPath = join(outputDir, "run-manifest.json");
  const routesInOrder = [...input.plan.routes].sort((left, right) => (
    releaseSurfaceProviderRouteId(left.providerId, left.transportId)
      .localeCompare(releaseSurfaceProviderRouteId(right.providerId, right.transportId))
  ));
  const liveRouteIds = new Set(input.contract.platforms[input.candidate.platform].requiredLiveProviderRoutes
    .map(({ providerId, transportId }) => releaseSurfaceProviderRouteId(providerId, transportId)));
  const routePaths = routesInOrder.map((route) => join(outputDir, `${route.providerId}--${route.transportId}.json`));
  for (const path of [manifestPath, ...routePaths]) {
    if (existsSync(path)) throw new Error(`provider route batch evidence already exists: ${path}`);
  }
  if (readdirSync(outputDir).length > 0) {
    throw new Error("provider route output directory must start empty");
  }
  const uniquePresets = uniqueRoutePresets(routesInOrder);
  const fetchImpl = input.fetchImpl ?? fetch;
  await assertPresetIdsAvailable(
    input.candidate.runtime.debugBase,
    input.token,
    uniquePresets,
    fetchImpl,
  );

  const createdPresetIds: string[] = [];
  let batch: ReleaseSurfaceProviderRouteBatch | undefined;
  let collectionError: unknown;
  try {
    for (const preset of uniquePresets) {
      // Track before POST because a transport failure can hide a successful
      // server-side write. DELETE is idempotent for an already-absent preset.
      createdPresetIds.push(preset.id);
      await savePreset(input.candidate.runtime.debugBase, input.token, preset, fetchImpl);
    }

    const now = input.now ?? (() => new Date());
    const startedAt = now().toISOString();
    const routes: ReleaseSurfaceProviderRoute[] = [];
    for (let index = 0; index < routesInOrder.length; index += 1) {
      const routePlan = routesInOrder[index]!;
      const evidencePath = routePaths[index]!;
      const collectorInput: CollectReleaseSurfaceProviderRouteInput = {
        candidate: input.candidate,
        preset: routePlan.preset,
        providerId: routePlan.providerId,
        transportId: routePlan.transportId,
        cwd: routePlan.cwd,
        targetHostOs: routePlan.targetHostOs,
        evidenceMode: liveRouteIds.has(releaseSurfaceProviderRouteId(routePlan.providerId, routePlan.transportId))
          ? "live-canary" : "identity-only",
        token: input.token,
        fetchImpl: input.fetchImpl,
        now,
      };
      const evidence = await (input.collectRoute ?? collectReleaseSurfaceProviderRouteEvidence)(collectorInput);
      writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      const route: ReleaseSurfaceProviderRoute = {
        ...evidence.route,
        evidence: identifyRegularFile(evidencePath, "provider route evidence"),
      };
      const evidenceErrors = (input.validateEvidence ?? validateReleaseSurfaceProviderRouteEvidence)({
        evidence,
        candidate: input.candidate,
        expectedRoute: route,
      });
      if (evidenceErrors.length > 0) {
        throw new Error(`provider route ${route.id} failed persisted evidence validation: ${evidenceErrors.join("; ")}`);
      }
      routes.push(route);
    }
    batch = {
      schema: RELEASE_SURFACE_PROVIDER_ROUTE_BATCH_SCHEMA,
      mode: "final-frozen-candidate",
      platform: input.candidate.platform,
      sourceCommit: input.candidate.sourceCommit,
      version: input.candidate.version,
      artifactSha256: input.candidate.distributionArtifact.sha256,
      processId: input.candidate.runtime.processId,
      instanceId: input.candidate.runtime.instanceId,
      startedAt,
      completedAt: now().toISOString(),
      routes,
    };
  } catch (error) {
    collectionError = error;
  }

  const cleanupErrors = await deleteOwnedPresets(
    input.candidate.runtime.debugBase,
    input.token,
    createdPresetIds,
    fetchImpl,
  );
  if (cleanupErrors.length > 0) {
    const prefix = collectionError instanceof Error
      ? `${collectionError.message}; `
      : collectionError !== undefined ? `${String(collectionError)}; ` : "";
    throw new Error(`${prefix}provider route preset cleanup failed: ${cleanupErrors.join("; ")}`);
  }
  if (collectionError !== undefined) throw collectionError;
  if (!batch) throw new Error("provider route batch did not produce a manifest");
  writeFileSync(manifestPath, `${JSON.stringify(batch, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return { batch, manifestPath };
}

function validatePreset(
  route: ReleaseSurfaceProviderRouteBatchPlanEntry,
  platform: ReleasePlatform,
  id: string,
  errors: string[],
): void {
  const preset = route?.preset;
  if (!preset || typeof preset !== "object" || !preset.id?.trim() || !preset.label?.trim()) {
    errors.push(`${id} requires a saved connection preset identity`);
    return;
  }
  if (preset.id.length > 256 || preset.label.length > 64) errors.push(`${id} preset identity is too long`);
  if (/[^\x20-\x7E]/.test(preset.id) || /[\r\n\0]/.test(preset.label)) errors.push(`${id} preset identity is invalid`);
  if (!Number.isSafeInteger(preset.createdMs) || preset.createdMs < 0
    || !Number.isSafeInteger(preset.lastUsedMs) || preset.lastUsedMs < 0) {
    errors.push(`${id} preset timestamps must be non-negative integers`);
  }
  const presetExtras = unknownKeys(preset as unknown as Record<string, unknown>, [
    "id", "label", "transport", "createdMs", "lastUsedMs",
  ]);
  if (presetExtras.length > 0 || preset.providerScan !== undefined) {
    errors.push(`${id} preset must be secret-free and omit cached provider scans or unknown fields`);
  }
  const kind = preset.transport?.kind;
  const expectedKind = route.transportId === "local-native" ? "local"
    : route.transportId === "local-wsl" ? "wsl" : "ssh";
  if (kind !== expectedKind) errors.push(`${id} requires preset transport ${expectedKind}`);
  if (route.transportId === "local-wsl") {
    if (platform !== "windows-installed") errors.push(`${id} is valid only for a Windows candidate`);
    if (kind === "wsl" && !preset.transport.distro?.trim()) errors.push(`${id} requires a WSL distro`);
  }
  if (route.transportId === "ssh-posix-native" && !["linux", "macos"].includes(route.targetHostOs ?? "")) {
    errors.push(`${id} requires targetHostOs linux or macos`);
  }
  if (route.transportId === "ssh-windows-native" && route.targetHostOs !== "windows") {
    errors.push(`${id} requires targetHostOs windows`);
  }
  if (route.transportId === "ssh-windows-wsl" && route.targetHostOs !== "windows") {
    errors.push(`${id} requires targetHostOs windows`);
  }
  if (["local-native", "local-wsl"].includes(route.transportId) && route.targetHostOs !== undefined) {
    errors.push(`${id} must not override the local candidate host OS`);
  }
  if (kind === "ssh") {
    const transportExtras = unknownKeys(preset.transport as unknown as Record<string, unknown>, [
      "kind", "host", "port", "keyVaultRef", "remoteGrokPath", "remoteRuntime", "wslDistro",
    ]);
    if (transportExtras.length > 0) errors.push(`${id} SSH preset contains unknown fields`);
    const runtime = preset.transport.remoteRuntime ?? "posix";
    const expectedRuntime = route.transportId === "ssh-windows-native" ? "windows"
      : route.transportId === "ssh-windows-wsl" ? "windows_wsl" : "posix";
    if (runtime !== expectedRuntime) errors.push(`${id} requires SSH remoteRuntime ${expectedRuntime}`);
    if (!preset.transport.host?.trim() || !preset.transport.remoteGrokPath?.trim()) {
      errors.push(`${id} requires an SSH host and remote Grok path`);
    }
    validateRemoteGrokPathFrame(preset.transport.remoteGrokPath, runtime, id, errors);
    if (preset.transport.port !== undefined
      && (!Number.isSafeInteger(preset.transport.port) || preset.transport.port <= 0 || preset.transport.port > 65_535)) {
      errors.push(`${id} SSH port is invalid`);
    }
    if (runtime === "windows_wsl" && !preset.transport.wslDistro?.trim()) {
      errors.push(`${id} requires an SSH WSL distro`);
    }
    if (runtime !== "windows_wsl" && preset.transport.wslDistro?.trim()) {
      errors.push(`${id} may set an SSH WSL distro only for remoteRuntime windows_wsl`);
    }
  } else if (kind === "wsl") {
    const transportExtras = unknownKeys(preset.transport as unknown as Record<string, unknown>, ["kind", "distro", "grokPath"]);
    if (transportExtras.length > 0) errors.push(`${id} WSL preset contains unknown fields`);
  } else if (kind === "local") {
    const transportExtras = unknownKeys(preset.transport as unknown as Record<string, unknown>, ["kind", "grokPath"]);
    if (transportExtras.length > 0) errors.push(`${id} local preset contains unknown fields`);
  }
}

function validateRemoteGrokPathFrame(
  value: string | undefined,
  runtime: string,
  id: string,
  errors: string[],
): void {
  const path = value?.trim() ?? "";
  if (!path) return;
  const bareCommand = !/[\\/:]/.test(path);
  if (bareCommand) {
    if (/\s/.test(path)) errors.push(`${id} remote Grok command name contains whitespace`);
    return;
  }
  const windowsAbsolute = /^\\\\/.test(path) || /^[A-Za-z]:[\\/]/.test(path);
  if (runtime === "windows" && !windowsAbsolute) {
    errors.push(`${id} remote Grok path must be a bare command or absolute Windows path`);
  }
  if (runtime !== "windows" && !path.startsWith("/")) {
    errors.push(`${id} remote Grok path must be a bare command or absolute POSIX path`);
  }
}

function unknownKeys(value: Record<string, unknown>, allowed: string[]): string[] {
  const accepted = new Set(allowed);
  return Object.keys(value).filter((key) => !accepted.has(key));
}

function uniqueRoutePresets(routes: ReleaseSurfaceProviderRouteBatchPlanEntry[]): ConnectionPreset[] {
  const values = new Map<string, ConnectionPreset>();
  for (const route of routes) {
    const existing = values.get(route.preset.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(route.preset)) {
      throw new Error(`provider route preset ${route.preset.id} has conflicting definitions`);
    }
    values.set(route.preset.id, route.preset);
  }
  return [...values.values()].sort((left, right) => left.id.localeCompare(right.id));
}

async function savePreset(base: string, token: string, preset: ConnectionPreset, fetchImpl: typeof fetch): Promise<void> {
  const response = await fetchImpl(`${base}/connections`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(preset),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`saving disposable route preset ${preset.id} failed ${response.status}: ${text.slice(0, 500)}`);
  const saved = JSON.parse(text) as ConnectionPreset;
  if (saved.id !== preset.id || JSON.stringify(saved.transport) !== JSON.stringify(preset.transport)) {
    throw new Error(`candidate changed disposable route preset ${preset.id}`);
  }
}

async function assertPresetIdsAvailable(
  base: string,
  token: string,
  presets: ConnectionPreset[],
  fetchImpl: typeof fetch,
): Promise<void> {
  const response = await fetchImpl(`${base}/connections`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`reading existing connection presets failed ${response.status}: ${text.slice(0, 500)}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("reading existing connection presets returned invalid JSON");
  }
  if (!body || typeof body !== "object" || !Array.isArray((body as { presets?: unknown }).presets)) {
    throw new Error("reading existing connection presets returned an invalid envelope");
  }
  const existingIds = new Set((body as { presets: unknown[] }).presets.flatMap((value) => (
    value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string"
      ? [(value as { id: string }).id]
      : []
  )));
  const collisions = presets.map((preset) => preset.id).filter((id) => existingIds.has(id));
  if (collisions.length > 0) {
    throw new Error(`provider route preset id already exists: ${collisions.join(", ")}`);
  }
}

async function deleteOwnedPresets(
  base: string,
  token: string,
  presetIds: string[],
  fetchImpl: typeof fetch,
): Promise<string[]> {
  const errors: string[] = [];
  for (const id of [...presetIds].reverse()) {
    try {
      const response = await fetchImpl(`${base}/connections/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      const text = await response.text();
      if (!response.ok) errors.push(`${id} returned ${response.status}: ${text.slice(0, 200)}`);
    } catch (error) {
      errors.push(`${id} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}

function requireRegularFile(path: string, label: string): string {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular non-link file`);
  return absolute;
}

function requireRegularDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a regular non-link directory`);
  return absolute;
}

function identifyRegularFile(path: string, label: string): { basename: string; sha256: string; bytes: number } {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular non-link file`);
  const bytes = readFileSync(absolute);
  if (bytes.length === 0) throw new Error(`${label} must not be empty`);
  return {
    basename: basename(absolute),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}
