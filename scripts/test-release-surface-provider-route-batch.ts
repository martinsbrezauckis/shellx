import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ConnectionPreset } from "../src/components/ConnectionPicker";
import type { ReleaseSurfaceCandidateAttestation } from "./lib/release-surface-candidate-attestation";
import {
  RELEASE_SURFACE_PROVIDER_ROUTE_BATCH_PLAN_SCHEMA,
  RELEASE_SURFACE_PROVIDER_ROUTE_BATCH_SCHEMA,
  collectReleaseSurfaceProviderRouteBatch,
  validateReleaseSurfaceProviderRouteBatchPlan,
  type ReleaseSurfaceProviderRouteBatchPlan,
} from "./lib/release-surface-provider-route-batch";
import type { ReleaseSurfaceProviderRouteEvidence } from "./lib/release-surface-provider-route-evidence";
import type { ReleaseSurfaceProviderRoute } from "./lib/release-surface-scenario-report";
import {
  loadFinalSurfaceContract,
  type FinalSurfaceRequiredProviderRoute,
} from "./lib/release-surface-receipts";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-provider-route-batch-"));
try {
  const contract = loadFinalSurfaceContract(join(root, "release", "surface-contract.json"));
  const plan = linuxPlan(contract.platforms["linux-installed"].requiredProviderRoutes);
  assert.deepEqual(validateReleaseSurfaceProviderRouteBatchPlan({
    plan,
    contract,
    platform: "linux-installed",
  }), []);

  const missing = structuredClone(plan);
  missing.routes.pop();
  assert(validateReleaseSurfaceProviderRouteBatchPlan({
    plan: missing,
    contract,
    platform: "linux-installed",
  }).some((error) => error.includes("exact declared provider-transport routes")));

  const invalidRuntime = structuredClone(plan);
  const windowsWsl = invalidRuntime.routes.find((route) => route.transportId === "ssh-windows-wsl")!;
  if (windowsWsl.preset.transport.kind === "ssh") windowsWsl.preset.transport.remoteRuntime = "windows";
  assert(validateReleaseSurfaceProviderRouteBatchPlan({
    plan: invalidRuntime,
    contract,
    platform: "linux-installed",
  }).some((error) => error.includes("requires SSH remoteRuntime windows_wsl")));

  const nativeWindowsWithPosixGrok = structuredClone(plan);
  const nativeWindows = nativeWindowsWithPosixGrok.routes.find(
    (route) => route.transportId === "ssh-windows-native",
  )!;
  if (nativeWindows.preset.transport.kind === "ssh") {
    nativeWindows.preset.transport.remoteGrokPath = "/home/release/.grok/bin/grok";
  }
  assert(validateReleaseSurfaceProviderRouteBatchPlan({
    plan: nativeWindowsWithPosixGrok,
    contract,
    platform: "linux-installed",
  }).some((error) => error.includes("absolute Windows path")));

  const windowsWslWithWindowsGrok = structuredClone(plan);
  const windowsWslWrongPath = windowsWslWithWindowsGrok.routes.find(
    (route) => route.transportId === "ssh-windows-wsl",
  )!;
  if (windowsWslWrongPath.preset.transport.kind === "ssh") {
    windowsWslWrongPath.preset.transport.remoteGrokPath = "C:\\Users\\release\\.grok\\bin\\grok.exe";
  }
  assert(validateReleaseSurfaceProviderRouteBatchPlan({
    plan: windowsWslWithWindowsGrok,
    contract,
    platform: "linux-installed",
  }).some((error) => error.includes("absolute POSIX path")));

  const posixWithDormantWslDistro = structuredClone(plan);
  const posixRoute = posixWithDormantWslDistro.routes.find(
    (route) => route.transportId === "ssh-posix-native",
  )!;
  if (posixRoute.preset.transport.kind === "ssh") {
    posixRoute.preset.transport.wslDistro = "Ubuntu-24.04";
  }
  assert(validateReleaseSurfaceProviderRouteBatchPlan({
    plan: posixWithDormantWslDistro,
    contract,
    platform: "linux-installed",
  }).some((error) => error.includes("only for remoteRuntime windows_wsl")));

  const unknownRouteField = structuredClone(plan) as ReleaseSurfaceProviderRouteBatchPlan & {
    routes: Array<ReleaseSurfaceProviderRouteBatchPlan["routes"][number] & { password?: string }>;
  };
  unknownRouteField.routes[0]!.password = "must-not-enter-the-plan";
  assert(validateReleaseSurfaceProviderRouteBatchPlan({
    plan: unknownRouteField,
    contract,
    platform: "linux-installed",
  }).some((error) => error.includes("contains unknown fields")));

  const cachedProviderScan = structuredClone(plan);
  cachedProviderScan.routes[0]!.preset.providerScan = [];
  assert(validateReleaseSurfaceProviderRouteBatchPlan({
    plan: cachedProviderScan,
    contract,
    platform: "linux-installed",
  }).some((error) => error.includes("must be secret-free")));

  const nonemptyOutputDir = join(temp, "nonempty-evidence");
  mkdirSync(nonemptyOutputDir);
  writeFileSync(join(nonemptyOutputDir, "stale.json"), "{}\n", "utf8");
  await assert.rejects(
    collectReleaseSurfaceProviderRouteBatch({
      plan,
      contract,
      candidate: fixtureCandidate(),
      token: "t".repeat(48),
      outputDir: nonemptyOutputDir,
    }),
    /must start empty/,
  );

  const outputDir = join(temp, "evidence");
  mkdirSync(outputDir);
  const candidate = fixtureCandidate();
  let savedPresets = 0;
  const deletedPresetIds: string[] = [];
  let tick = Date.parse("2026-07-28T20:00:00.000Z");
  const collected = await collectReleaseSurfaceProviderRouteBatch({
    plan,
    contract,
    candidate,
    token: "t".repeat(48),
    outputDir,
    now: () => new Date(tick += 100),
    fetchImpl: async (url, init) => {
      const parsed = new URL(String(url));
      const method = init?.method ?? "GET";
      if (method === "GET" && parsed.pathname === "/connections") {
        return Response.json({ presets: [] });
      }
      if (method === "DELETE" && parsed.pathname.startsWith("/connections/")) {
        deletedPresetIds.push(decodeURIComponent(parsed.pathname.slice("/connections/".length)));
        return new Response(null, { status: 204 });
      }
      savedPresets += 1;
      return new Response(String(init?.body), { status: 201, headers: { "Content-Type": "application/json" } });
    },
    collectRoute: async (input) => fixtureEvidence(candidate, input.providerId, input.transportId, input.targetHostOs, input.evidenceMode),
    validateEvidence: () => [],
  });
  assert.equal(savedPresets, 4, "one disposable preset is saved per unique transport target");
  assert.deepEqual(
    [...deletedPresetIds].sort(),
    ["release-local", "release-ssh-posix", "release-ssh-windows", "release-ssh-windows-wsl"],
    "every batch-owned preset is removed after collection",
  );
  assert.equal(collected.batch.schema, RELEASE_SURFACE_PROVIDER_ROUTE_BATCH_SCHEMA);
  assert.equal(collected.batch.routes.length, 8);
  assert.deepEqual(
    collected.batch.routes.filter((route) => route.evidenceMode === "live-canary").map((route) => route.id).sort(),
    contract.platforms["linux-installed"].requiredLiveProviderRoutes
      .map(({ providerId, transportId }) => `${providerId}::${transportId}`).sort(),
    "only the contract-selected coverage routes spend live provider generations",
  );
  assert.deepEqual(
    collected.batch.routes.map((route) => route.id),
    [...collected.batch.routes.map((route) => route.id)].sort(),
  );
  assert.equal(readdirSync(outputDir).length, 9, "eight route evidence files plus one manifest are create-only");
  assert.deepEqual(JSON.parse(readFileSync(collected.manifestPath, "utf8")), collected.batch);
  assert(collected.batch.routes.every((route) => route.evidence.bytes > 0 && /^[a-f0-9]{64}$/.test(route.evidence.sha256)));
  await assert.rejects(
    collectReleaseSurfaceProviderRouteBatch({
      plan,
      contract,
      candidate,
      token: "t".repeat(48),
      outputDir,
      fetchImpl: async () => Response.json({ presets: [] }),
      collectRoute: async (input) => fixtureEvidence(candidate, input.providerId, input.transportId, input.targetHostOs, input.evidenceMode),
      validateEvidence: () => [],
    }),
    /evidence already exists/,
  );

  const collisionDir = join(temp, "collision-evidence");
  mkdirSync(collisionDir);
  let collisionWrites = 0;
  await assert.rejects(
    collectReleaseSurfaceProviderRouteBatch({
      plan,
      contract,
      candidate,
      token: "t".repeat(48),
      outputDir: collisionDir,
      fetchImpl: async (_url, init) => {
        if ((init?.method ?? "GET") === "GET") {
          return Response.json({ presets: [{ id: "release-local" }] });
        }
        collisionWrites += 1;
        return new Response(null, { status: 204 });
      },
      collectRoute: async (input) => fixtureEvidence(candidate, input.providerId, input.transportId, input.targetHostOs, input.evidenceMode),
      validateEvidence: () => [],
    }),
    /preset id already exists: release-local/,
  );
  assert.equal(collisionWrites, 0, "an existing connection preset is never overwritten or deleted");

  const failedDir = join(temp, "failed-evidence");
  mkdirSync(failedDir);
  const failedDeletedIds: string[] = [];
  let attemptedRoutes = 0;
  await assert.rejects(
    collectReleaseSurfaceProviderRouteBatch({
      plan,
      contract,
      candidate,
      token: "t".repeat(48),
      outputDir: failedDir,
      fetchImpl: async (url, init) => {
        const parsed = new URL(String(url));
        const method = init?.method ?? "GET";
        if (method === "GET") return Response.json({ presets: [] });
        if (method === "DELETE") {
          failedDeletedIds.push(decodeURIComponent(parsed.pathname.slice("/connections/".length)));
          return new Response(null, { status: 204 });
        }
        return new Response(String(init?.body), { status: 201, headers: { "Content-Type": "application/json" } });
      },
      collectRoute: async (input) => {
        attemptedRoutes += 1;
        if (attemptedRoutes === 2) throw new Error("fixture provider route failed");
        return fixtureEvidence(candidate, input.providerId, input.transportId, input.targetHostOs, input.evidenceMode);
      },
      validateEvidence: () => [],
    }),
    /fixture provider route failed/,
  );
  assert.equal(failedDeletedIds.length, 4, "batch-owned presets are removed after route failure");
  assert(!readdirSync(failedDir).includes("run-manifest.json"), "a failed or unclean batch cannot write a manifest");

  const cleanupFailureDir = join(temp, "cleanup-failure-evidence");
  mkdirSync(cleanupFailureDir);
  await assert.rejects(
    collectReleaseSurfaceProviderRouteBatch({
      plan,
      contract,
      candidate,
      token: "t".repeat(48),
      outputDir: cleanupFailureDir,
      fetchImpl: async (_url, init) => {
        const method = init?.method ?? "GET";
        if (method === "GET") return Response.json({ presets: [] });
        if (method === "DELETE") return Response.json({ error: "fixture cleanup denied" }, { status: 500 });
        return new Response(String(init?.body), { status: 201, headers: { "Content-Type": "application/json" } });
      },
      collectRoute: async (input) => fixtureEvidence(candidate, input.providerId, input.transportId, input.targetHostOs, input.evidenceMode),
      validateEvidence: () => [],
    }),
    /provider route preset cleanup failed.*fixture cleanup denied/,
  );
  assert(
    !readdirSync(cleanupFailureDir).includes("run-manifest.json"),
    "cleanup failure prevents a completed batch manifest",
  );

  console.log("Release surface provider route batch tests passed");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

function linuxPlan(requiredRoutes: FinalSurfaceRequiredProviderRoute[]): ReleaseSurfaceProviderRouteBatchPlan {
  const presets = {
    "local-native": preset("release-local", { kind: "local" }),
    "ssh-posix-native": preset("release-ssh-posix", {
      kind: "ssh",
      host: "remote-macos.test",
      remoteGrokPath: "/usr/local/bin/grok",
      remoteRuntime: "posix",
    }),
    "ssh-windows-native": preset("release-ssh-windows", {
      kind: "ssh",
      host: "windows-laptop.test",
      remoteGrokPath: "C:\\Users\\release\\.grok\\bin\\grok.exe",
      remoteRuntime: "windows",
    }),
    "ssh-windows-wsl": preset("release-ssh-windows-wsl", {
      kind: "ssh",
      host: "windows-laptop.test",
      remoteGrokPath: "/home/release/.grok/bin/grok",
      remoteRuntime: "windows_wsl",
      wslDistro: "Ubuntu-24.04",
    }),
  } satisfies Record<string, ConnectionPreset>;
  return {
    schema: RELEASE_SURFACE_PROVIDER_ROUTE_BATCH_PLAN_SCHEMA,
    platform: "linux-installed",
    routes: requiredRoutes.map(({ providerId, transportId }) => ({
      providerId,
      transportId,
      cwd: transportId === "ssh-windows-native"
        ? "C:\\Users\\release\\shellx-test"
        : transportId === "ssh-windows-wsl" ? "/home/release/shellx-test" : "/tmp/shellx-release",
      ...(transportId === "ssh-posix-native" ? { targetHostOs: "macos" as const }
        : transportId.startsWith("ssh-windows") ? { targetHostOs: "windows" as const } : {}),
      preset: presets[transportId as keyof typeof presets],
    })),
  } as ReleaseSurfaceProviderRouteBatchPlan;
}

function preset(id: string, transport: ConnectionPreset["transport"]): ConnectionPreset {
  return { id, label: id, transport, createdMs: 1, lastUsedMs: 1 };
}

function fixtureCandidate(): ReleaseSurfaceCandidateAttestation {
  return {
    schema: "shellx/release-surface-candidate-attestation@5",
    mode: "final-frozen-candidate",
    platform: "linux-installed",
    sourceCommit: "b".repeat(40),
    version: "0.3.5",
    distributionArtifact: { basename: "shellx.deb", sha256: "a".repeat(64), bytes: 1024 },
    runtime: {
      processId: 4321,
      instanceId: "fixture-instance",
      debugBase: "http://127.0.0.1:31341",
      debugPort: 31341,
      debugTokenPath: "/tmp/shellxagent.token",
      executable: { basename: "shellx", sha256: "c".repeat(64), bytes: 2048 },
    },
  } as unknown as ReleaseSurfaceCandidateAttestation;
}

function fixtureEvidence(
  candidate: ReleaseSurfaceCandidateAttestation,
  providerId: string,
  transportId: string,
  targetHostOs: "windows" | "macos" | "linux" | undefined,
  evidenceMode: "identity-only" | "live-canary",
): ReleaseSurfaceProviderRouteEvidence {
  const startedAt = "2026-07-28T20:00:01.000Z";
  const completedAt = "2026-07-28T20:00:02.000Z";
  const windows = transportId.includes("windows");
  const wsl = transportId.endsWith("wsl");
  const protocol = providerId === "grok" ? "acp"
    : providerId === "codex-cli" ? "codex-jsonl"
      : providerId === "claude-code" ? "claude-stream-json" : "antigravity-stream-json";
  const route: Omit<ReleaseSurfaceProviderRoute, "evidence"> = {
    id: `${providerId}::${transportId}`,
    providerId,
    transportId,
    status: "pass",
    evidenceMode,
    appHostPlatform: candidate.platform,
    target: {
      transport: transportId === "local-native" ? "local" : "ssh",
      hostOs: windows ? "windows" : targetHostOs ?? "linux",
      runtimeKind: wsl ? "wsl" : windows ? "windows-native" : "posix-native",
      runtimeOs: wsl ? "linux" : windows ? "windows" : targetHostOs ?? "linux",
      shellKind: wsl ? "wsl-bash" : windows ? "powershell" : "posix-shell",
      hostFingerprintSha256: "d".repeat(64),
      ...(wsl ? { wslDistro: "Ubuntu-24.04" } : {}),
    },
    provider: {
      executable: windows && !wsl ? "C:\\Users\\release\\provider.exe" : "/usr/bin/provider",
      executableSha256: "e".repeat(64),
      executableBytes: 4096,
      version: "1.0.0",
    },
    stream: {
      canaryId: evidenceMode === "live-canary" ? "shellx/provider-route-canary@1" : null,
      nativeProtocol: protocol,
      nativeStreamKind: providerId === "grok" || providerId === "codex-cli" ? "jsonl" : "stream-json",
      normalizedSchema: "shellx/provider-session-event@1",
      eventCount: evidenceMode === "live-canary" ? 3 : 0,
      observedEventKinds: evidenceMode === "live-canary" ? ["started", "text", "completed"] : [],
      finalState: evidenceMode === "live-canary" ? "completed" : "not-run",
      canaryMatched: evidenceMode === "live-canary",
      gapCount: 0,
      parseErrorCount: 0,
    },
    cleanup: "pass",
    startedAt,
    completedAt,
    observed: "fixture route completed",
  };
  return {
    schema: "shellx/release-surface-provider-route-evidence@3",
    mode: "final-frozen-candidate",
    evidenceMode,
    collector: {
      id: "shellx-release-provider-route-collector@1",
      sourceCommit: candidate.sourceCommit,
      startedAt,
      completedAt,
    },
    candidate: {
      platform: candidate.platform,
      sourceCommit: candidate.sourceCommit,
      version: candidate.version,
      artifactSha256: candidate.distributionArtifact.sha256,
      processId: candidate.runtime.processId,
      instanceId: candidate.runtime.instanceId,
      debugBase: candidate.runtime.debugBase,
    },
    healthBefore: {} as ReleaseSurfaceProviderRouteEvidence["healthBefore"],
    healthAfter: {} as ReleaseSurfaceProviderRouteEvidence["healthAfter"],
    eventStream: { transport: evidenceMode === "live-canary" ? "authenticated-websocket" : "not-opened", lagWarnings: 0 },
    capabilitySnapshot: {} as ReleaseSurfaceProviderRouteEvidence["capabilitySnapshot"],
    route,
    rawFrames: [],
    normalizedEvents: [],
    cleanup: {} as ReleaseSurfaceProviderRouteEvidence["cleanup"],
  };
}
