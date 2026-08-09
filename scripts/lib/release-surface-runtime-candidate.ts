import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertDebugHealthVersion } from "../shellx-debug-version";
import {
  resolveShellxDebugApiConnection,
  type ShellxDebugApiConnection,
} from "../shellx-debug-paths";
import type { ReleaseSurfaceDriverRequest } from "./release-surface-driver-protocol";
import {
  collectReleaseSurfacePosixNativeRuntime,
  validateReleaseSurfacePosixNativeRuntime,
  validateReleaseSurfacePosixObservationWindow,
  validateReleaseSurfacePosixRuntimeBinding,
  type ReleaseSurfacePosixNativeRuntime,
} from "./release-surface-posix-native-runtime";
import {
  collectReleaseSurfaceWindowsNativeRuntime,
  validateReleaseSurfaceWindowsNativeRuntime,
  validateReleaseSurfaceWindowsObservationWindow,
  validateReleaseSurfaceWindowsRuntimeBinding,
  type ReleaseSurfaceWindowsNativeRuntime,
} from "./release-surface-windows-native-runtime";

export const RELEASE_SURFACE_RUNTIME_PROBE_SCHEMA = "shellx/release-surface-runtime-probe@5";

export interface ReleaseSurfaceRuntimeProbe {
  schema: typeof RELEASE_SURFACE_RUNTIME_PROBE_SCHEMA;
  phase: "before-driver" | "after-driver";
  observedAt: string;
  runtime: ReleaseSurfaceDriverRequest["runtime"];
  health: {
    processId: number;
    instanceId: string;
    appVersion: string;
    buildCommit: string;
    debugPort: number;
  };
  mcpHealth?: {
    processId: number;
    instanceId: string;
    appVersion: string;
    buildCommit: string;
    mcpPort: number;
  };
  protectedProbe: { path: "/browser/state"; status: 200 };
  mcpProtectedProbe?: { path: "/mcp"; method: "tools/list"; status: 200; toolCount: number };
  windowsNativeRuntime?: ReleaseSurfaceWindowsNativeRuntime;
  posixNativeRuntime?: ReleaseSurfacePosixNativeRuntime;
}

export async function resolveReleaseSurfaceRuntimeCandidate(
  request: ReleaseSurfaceDriverRequest,
): Promise<ShellxDebugApiConnection> {
  return (await inspectReleaseSurfaceRuntimeCandidate(request, false)).connection;
}

export async function probeReleaseSurfaceRuntimeCandidate(
  request: ReleaseSurfaceDriverRequest,
  phase: ReleaseSurfaceRuntimeProbe["phase"],
): Promise<ReleaseSurfaceRuntimeProbe> {
  const inspected = await inspectReleaseSurfaceRuntimeCandidate(request, true);
  return {
    schema: RELEASE_SURFACE_RUNTIME_PROBE_SCHEMA,
    phase,
    observedAt: new Date().toISOString(),
    runtime: request.runtime,
    health: inspected.health,
    protectedProbe: { path: "/browser/state", status: 200 },
    ...(inspected.mcpHealth && inspected.mcpProtectedProbe
      ? { mcpHealth: inspected.mcpHealth, mcpProtectedProbe: inspected.mcpProtectedProbe }
      : {}),
    ...(inspected.windowsNativeRuntime ? { windowsNativeRuntime: inspected.windowsNativeRuntime } : {}),
    ...(inspected.posixNativeRuntime ? { posixNativeRuntime: inspected.posixNativeRuntime } : {}),
  };
}

export function validateReleaseSurfaceRuntimeProbe(
  probe: ReleaseSurfaceRuntimeProbe,
  request: ReleaseSurfaceDriverRequest,
  phase: ReleaseSurfaceRuntimeProbe["phase"],
): string[] {
  const errors: string[] = [];
  if (probe.schema !== RELEASE_SURFACE_RUNTIME_PROBE_SCHEMA) {
    errors.push(`runtime probe schema must be ${RELEASE_SURFACE_RUNTIME_PROBE_SCHEMA}`);
  }
  if (probe.phase !== phase) errors.push(`runtime probe phase must be ${phase}`);
  if (!Number.isFinite(Date.parse(probe.observedAt))) errors.push("runtime probe observedAt must be a valid ISO timestamp");
  if (JSON.stringify(probe.runtime) !== JSON.stringify(request.runtime)) {
    errors.push("runtime probe identity must match the exact driver request");
  }
  if (probe.health?.processId !== request.runtime.processId) errors.push("runtime probe processId does not match");
  if (probe.health?.instanceId !== request.runtime.instanceId) errors.push("runtime probe instanceId does not match");
  if (probe.health?.appVersion !== request.version) errors.push("runtime probe appVersion does not match");
  if (probe.health?.buildCommit !== request.sourceCommit) errors.push("runtime probe buildCommit does not match");
  if (probe.health?.debugPort !== Number(new URL(request.runtime.debugBase).port)) {
    errors.push("runtime probe debugPort does not match");
  }
  if (probe.protectedProbe?.path !== "/browser/state" || probe.protectedProbe?.status !== 200) {
    errors.push("runtime probe must prove the protected /browser/state endpoint");
  }
  if (request.driverKind === "host-mcp-tool") {
    if (probe.mcpHealth?.processId !== request.runtime.processId) errors.push("runtime MCP probe processId does not match");
    if (probe.mcpHealth?.instanceId !== request.runtime.instanceId) errors.push("runtime MCP probe instanceId does not match");
    if (probe.mcpHealth?.appVersion !== request.version) errors.push("runtime MCP probe appVersion does not match");
    if (probe.mcpHealth?.buildCommit !== request.sourceCommit) errors.push("runtime MCP probe buildCommit does not match");
    if (probe.mcpHealth?.mcpPort !== Number(new URL(request.runtime.mcpBase).port)) {
      errors.push("runtime MCP probe port does not match");
    }
    if (probe.mcpProtectedProbe?.path !== "/mcp" || probe.mcpProtectedProbe?.method !== "tools/list"
      || probe.mcpProtectedProbe?.status !== 200 || !Number.isSafeInteger(probe.mcpProtectedProbe?.toolCount)
      || probe.mcpProtectedProbe.toolCount <= 0) {
      errors.push("runtime probe must prove the protected MCP tools/list endpoint");
    }
  } else if (probe.mcpHealth || probe.mcpProtectedProbe) {
    errors.push("non-MCP runtime probes must not carry Host MCP evidence");
  }
  if (request.platform === "windows-installed") {
    if (probe.posixNativeRuntime) errors.push("POSIX native runtime evidence is not valid for a Windows probe");
    if (!request.runtime.windowsNative) {
      errors.push("Windows runtime request is missing its native binding");
    }
    if (!probe.windowsNativeRuntime) {
      errors.push("Windows runtime probe is missing native process and listener evidence");
    } else {
      errors.push(...validateReleaseSurfaceWindowsNativeRuntime(probe.windowsNativeRuntime, {
        processId: request.runtime.processId,
        port: Number(new URL(request.runtime.debugBase).port),
        imagePath: request.runtime.installedPayloadPath,
        imageSha256: request.runtime.executableSha256,
      }).map((error) => `Windows runtime probe: ${error}`));
      if (request.runtime.windowsNative) {
        errors.push(...validateReleaseSurfaceWindowsRuntimeBinding(
          request.runtime.windowsNative,
          probe.windowsNativeRuntime,
        ));
      }
      errors.push(...validateReleaseSurfaceWindowsObservationWindow(
        probe.windowsNativeRuntime.observedAt,
        probe.observedAt,
        "Windows native runtime probe observation",
      ));
    }
  } else {
    if (probe.windowsNativeRuntime) errors.push("Windows native runtime evidence is not valid for a non-Windows probe");
    if (!request.runtime.posixNative) {
      errors.push("POSIX runtime request is missing its native binding");
    }
    if (!probe.posixNativeRuntime) {
      errors.push("POSIX runtime probe is missing native process and listener evidence");
    } else {
      const platform = request.platform === "linux-installed" ? "linux" : "macos";
      errors.push(...validateReleaseSurfacePosixNativeRuntime(probe.posixNativeRuntime, {
        platform,
        processId: request.runtime.processId,
        port: Number(new URL(request.runtime.debugBase).port),
        imagePath: request.runtime.installedPayloadPath,
        imageSha256: request.runtime.executableSha256,
      }).map((error) => `POSIX runtime probe: ${error}`));
      if (request.runtime.posixNative) {
        errors.push(...validateReleaseSurfacePosixRuntimeBinding(request.runtime.posixNative, probe.posixNativeRuntime));
      }
      errors.push(...validateReleaseSurfacePosixObservationWindow(
        probe.posixNativeRuntime.observedAt,
        probe.observedAt,
        "POSIX native runtime probe observation",
      ));
    }
  }
  return errors;
}

async function inspectReleaseSurfaceRuntimeCandidate(
  request: ReleaseSurfaceDriverRequest,
  includeNative: boolean,
): Promise<{
  connection: ShellxDebugApiConnection;
  health: ReleaseSurfaceRuntimeProbe["health"];
  mcpHealth?: NonNullable<ReleaseSurfaceRuntimeProbe["mcpHealth"]>;
  mcpProtectedProbe?: NonNullable<ReleaseSurfaceRuntimeProbe["mcpProtectedProbe"]>;
  windowsNativeRuntime?: ReleaseSurfaceWindowsNativeRuntime;
  posixNativeRuntime?: ReleaseSurfacePosixNativeRuntime;
}> {
  let windowsNativeRuntime: ReleaseSurfaceWindowsNativeRuntime | undefined;
  let posixNativeRuntime: ReleaseSurfacePosixNativeRuntime | undefined;
  if (includeNative && request.platform === "windows-installed") {
    if (!request.runtime.windowsNative) throw new Error("Windows candidate request is missing native runtime binding");
    windowsNativeRuntime = collectReleaseSurfaceWindowsNativeRuntime({
      processId: request.runtime.processId,
      port: Number(new URL(request.runtime.debugBase).port),
    });
    const nativeErrors = validateReleaseSurfaceWindowsRuntimeBinding(
      request.runtime.windowsNative,
      windowsNativeRuntime,
    );
    if (nativeErrors.length > 0) throw new Error(`Windows candidate runtime changed: ${nativeErrors.join("; ")}`);
  } else if (includeNative) {
    if (!request.runtime.posixNative) throw new Error("POSIX candidate request is missing native runtime binding");
    posixNativeRuntime = collectReleaseSurfacePosixNativeRuntime({
      platform: request.platform === "linux-installed" ? "linux" : "macos",
      processId: request.runtime.processId,
      port: Number(new URL(request.runtime.debugBase).port),
    });
    const nativeErrors = validateReleaseSurfacePosixRuntimeBinding(request.runtime.posixNative, posixNativeRuntime);
    if (nativeErrors.length > 0) throw new Error(`POSIX candidate runtime changed: ${nativeErrors.join("; ")}`);
  }
  const token = readCandidateToken(request.runtime.debugTokenPath, request.platform, "Debug API");
  const connection = await resolveShellxDebugApiConnection({
    base: request.runtime.debugBase,
    token,
    probePath: "/browser/state",
    timeoutMs: 3_000,
  });
  if (normalizeBase(connection.base) !== normalizeBase(request.runtime.debugBase)) {
    throw new Error("resolved Debug API base drifted from the candidate attestation");
  }
  const response = await fetch(`${connection.base}/health`, {
    headers: { Authorization: `Bearer ${connection.token}` },
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`candidate /health returned ${response.status}: ${await response.text()}`);
  await assertDebugHealthVersion(response.clone(), connection.base);
  const health = await response.json() as Record<string, unknown>;
  if (health.processId !== request.runtime.processId) {
    throw new Error(`candidate /health processId ${String(health.processId)} does not match PID ${request.runtime.processId}`);
  }
  if (health.instanceId !== request.runtime.instanceId) {
    throw new Error("candidate /health instanceId does not match the attested run nonce");
  }
  if (health.appVersion !== request.version && health.app_version !== request.version) {
    throw new Error("candidate /health app version does not match the frozen request");
  }
  if (health.buildCommit !== request.sourceCommit && health.build_commit !== request.sourceCommit) {
    throw new Error("candidate /health build commit does not match the frozen request");
  }
  const port = health.debugApiPort ?? health.debug_api_port;
  if (port !== Number(new URL(request.runtime.debugBase).port)) {
    throw new Error("candidate /health debug port does not match the attested endpoint");
  }
  let mcpEvidence: {
    mcpHealth: NonNullable<ReleaseSurfaceRuntimeProbe["mcpHealth"]>;
    mcpProtectedProbe: NonNullable<ReleaseSurfaceRuntimeProbe["mcpProtectedProbe"]>;
  } | undefined;
  if (request.driverKind === "host-mcp-tool") {
    const mcpResponse = await fetch(`${normalizeBase(request.runtime.mcpBase)}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!mcpResponse.ok) throw new Error(`candidate MCP /health returned ${mcpResponse.status}: ${await mcpResponse.text()}`);
    const mcpHealth = await mcpResponse.json() as Record<string, unknown>;
    if (mcpHealth.processId !== request.runtime.processId) {
      throw new Error(`candidate MCP /health processId ${String(mcpHealth.processId)} does not match PID ${request.runtime.processId}`);
    }
    if (mcpHealth.instanceId !== request.runtime.instanceId) {
      throw new Error("candidate MCP /health instanceId does not match the attested run nonce");
    }
    if (mcpHealth.appVersion !== request.version && mcpHealth.app_version !== request.version) {
      throw new Error("candidate MCP /health app version does not match the frozen request");
    }
    if (mcpHealth.buildCommit !== request.sourceCommit && mcpHealth.build_commit !== request.sourceCommit) {
      throw new Error("candidate MCP /health build commit does not match the frozen request");
    }
    const resolvedMcpPort = mcpHealth.mcpPort ?? mcpHealth.mcp_port;
    if (resolvedMcpPort !== Number(new URL(request.runtime.mcpBase).port)) {
      throw new Error("candidate MCP /health port does not match the attested endpoint");
    }
    const mcpToken = readCandidateToken(request.runtime.mcpTokenPath, request.platform, "MCP");
    const mcpProtectedResponse = await fetch(`${normalizeBase(request.runtime.mcpBase)}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mcpToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "shellx-release-runtime-probe", method: "tools/list", params: {} }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!mcpProtectedResponse.ok) {
      throw new Error(`candidate MCP tools/list returned ${mcpProtectedResponse.status}: ${await mcpProtectedResponse.text()}`);
    }
    const mcpProtected = await mcpProtectedResponse.json() as Record<string, unknown>;
    const tools = (mcpProtected.result as Record<string, unknown> | undefined)?.tools;
    if (mcpProtected.jsonrpc !== "2.0" || mcpProtected.id !== "shellx-release-runtime-probe" || !Array.isArray(tools)) {
      throw new Error("candidate MCP tools/list returned an invalid JSON-RPC result");
    }
    mcpEvidence = {
      mcpHealth: {
        processId: Number(mcpHealth.processId),
        instanceId: String(mcpHealth.instanceId),
        appVersion: String(mcpHealth.appVersion ?? mcpHealth.app_version),
        buildCommit: String(mcpHealth.buildCommit ?? mcpHealth.build_commit),
        mcpPort: Number(resolvedMcpPort),
      },
      mcpProtectedProbe: { path: "/mcp", method: "tools/list", status: 200, toolCount: tools.length },
    };
  }
  return {
    connection,
    ...(windowsNativeRuntime ? { windowsNativeRuntime } : {}),
    ...(posixNativeRuntime ? { posixNativeRuntime } : {}),
    ...(mcpEvidence ?? {}),
    health: {
      processId: Number(health.processId),
      instanceId: String(health.instanceId),
      appVersion: String(health.appVersion ?? health.app_version),
      buildCommit: String(health.buildCommit ?? health.build_commit),
      debugPort: Number(port),
    },
  };
}

function readCandidateToken(
  path: string,
  platform: ReleaseSurfaceDriverRequest["platform"],
  label: "Debug API" | "MCP",
): string {
  const tokenPath = nodeReadableTokenPath(path, platform, label);
  const tokenStat = lstatSync(tokenPath);
  if (tokenStat.isSymbolicLink() || !tokenStat.isFile()) {
    throw new Error(`candidate ${label} token must be a regular non-symlink file: ${tokenPath}`);
  }
  const token = readFileSync(tokenPath, "utf8").trim();
  if (token.length < 32) throw new Error(`candidate ${label} token file is invalid`);
  return token;
}

function nodeReadableTokenPath(
  path: string,
  platform: ReleaseSurfaceDriverRequest["platform"],
  label: "Debug API" | "MCP",
): string {
  if (platform !== "windows-installed" || process.platform === "win32" || !/^[A-Za-z]:[\\/]/.test(path)) {
    return resolve(path);
  }
  const result = spawnSync("wslpath", ["-u", path], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(`unable to map candidate ${label} token ${path}`);
  return resolve(result.stdout.trim());
}

function normalizeBase(value: string): string {
  return value.replace(/\/$/, "");
}
