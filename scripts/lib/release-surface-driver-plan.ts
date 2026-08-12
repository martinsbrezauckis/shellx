import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ReleasePlatform,
  ReleaseSurfaceInventory,
  ReleaseSurfaceKind,
} from "./release-surface-inventory";
import {
  RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  type ReleaseSurfaceDriverManifest,
} from "./release-surface-driver-protocol";
import { validateReleaseUiControlOracle } from "./release-ui-driver-families";
import {
  releaseSurfaceControllerNodeArguments,
} from "./release-surface-controller-binding";

export const FINAL_SURFACE_DRIVER_PLAN_SCHEMA = "shellx/final-surface-driver-plan@2";

export type FinalSurfaceDriverPlatformStatus = "building" | "ready";

export interface FinalSurfaceDriverDefinition {
  id: string;
  kind: ReleaseSurfaceKind;
  entrypoint: string;
  platforms: Partial<Record<ReleasePlatform, FinalSurfaceDriverPlatformStatus>>;
}

export interface FinalSurfaceDriverAssignment {
  surfaceId: string;
  driverId: string;
  fixtureId: string;
  expectedEffect: string;
  oracleId: string;
  cleanupId: string;
}

export interface FinalSurfaceDriverPlan {
  schema: typeof FINAL_SURFACE_DRIVER_PLAN_SCHEMA;
  mode: "final-frozen-candidate";
  inventoryDigest: string;
  releaseReady: boolean;
  drivers: FinalSurfaceDriverDefinition[];
  assignments: FinalSurfaceDriverAssignment[];
}

export interface FinalSurfaceDriverPlanFinding {
  ruleId: string;
  detail: string;
  surfaceId?: string;
}

export interface FinalSurfaceDriverPlanVerification {
  status: "ready" | "building" | "invalid";
  findings: FinalSurfaceDriverPlanFinding[];
  counts: {
    inventoryItems: number;
    inventoryCells: number;
    assigned: number;
    ready: number;
    missing: number;
    readyByKind: Record<ReleaseSurfaceKind, number>;
    readyByPlatform: Record<ReleasePlatform, number>;
  };
}

export function loadFinalSurfaceDriverPlan(path: string): FinalSurfaceDriverPlan {
  return JSON.parse(readFileSync(path, "utf8")) as FinalSurfaceDriverPlan;
}

export function verifyFinalSurfaceDriverPlan(
  plan: FinalSurfaceDriverPlan,
  inventory: ReleaseSurfaceInventory,
  rootDir?: string,
): FinalSurfaceDriverPlanVerification {
  const findings: FinalSurfaceDriverPlanFinding[] = [];
  const drivers = new Map<string, FinalSurfaceDriverDefinition>();
  const readyManifests = new Map<string, ReleaseSurfaceDriverManifest>();
  for (const driver of plan.drivers ?? []) {
    if (!driver.id?.trim()) {
      findings.push({ ruleId: "driver-id", detail: "driver id is required" });
      continue;
    }
    if (drivers.has(driver.id)) {
      findings.push({ ruleId: "driver-duplicate", detail: `driver ${driver.id} is declared more than once` });
      continue;
    }
    drivers.set(driver.id, driver);
    if (!inventory.counts[driver.kind] && inventory.counts[driver.kind] !== 0) {
      findings.push({ ruleId: "driver-kind", detail: `driver ${driver.id} uses unknown kind ${driver.kind}` });
    }
    const driverPlatforms = Object.entries(driver.platforms ?? {});
    if (driverPlatforms.length === 0) {
      findings.push({ ruleId: "driver-platforms", detail: `driver ${driver.id} must declare at least one platform status` });
    }
    for (const [platform, status] of driverPlatforms) {
      if (!inventory.platforms.includes(platform as ReleasePlatform)) {
        findings.push({ ruleId: "driver-platform", detail: `driver ${driver.id} names unknown platform ${platform}` });
      }
      if (status !== "building" && status !== "ready") {
        findings.push({ ruleId: "driver-platform-status", detail: `driver ${driver.id} has invalid ${platform} status ${String(status)}` });
      }
    }
    if (!isSafeRepositoryPath(driver.entrypoint)) {
      findings.push({ ruleId: "driver-entrypoint", detail: `driver ${driver.id} must use a contained repository-relative entrypoint` });
    } else if (driverPlatforms.some(([, status]) => status === "ready") && rootDir) {
      const described = describeReadyDriver(rootDir, driver);
      if (typeof described === "string") findings.push({ ruleId: "driver-entrypoint", detail: described });
      else readyManifests.set(driver.id, described);
    }
  }

  if (plan.schema !== FINAL_SURFACE_DRIVER_PLAN_SCHEMA) {
    findings.push({ ruleId: "plan-schema", detail: `expected ${FINAL_SURFACE_DRIVER_PLAN_SCHEMA}` });
  }
  if (plan.mode !== "final-frozen-candidate") {
    findings.push({ ruleId: "plan-mode", detail: "driver plan must be final-frozen-candidate only" });
  }
  if (plan.inventoryDigest !== inventory.digest) {
    findings.push({ ruleId: "plan-inventory-digest", detail: `expected ${inventory.digest}, got ${plan.inventoryDigest}` });
  }

  const inventoryById = new Map(inventory.items.map((item) => [item.id, item]));
  const assignments = new Map<string, FinalSurfaceDriverAssignment>();
  const inventoryCells = inventory.items.reduce((sum, surface) => sum + surface.platforms.length, 0);
  let ready = 0;
  const readyByKind = emptyKindCounts();
  const readyByPlatform = Object.fromEntries(inventory.platforms.map((platform) => [platform, 0])) as Record<ReleasePlatform, number>;
  for (const assignment of plan.assignments ?? []) {
    const surface = inventoryById.get(assignment.surfaceId);
    if (!surface) {
      findings.push({ ruleId: "assignment-unknown", detail: "assignment names a surface outside the exact inventory", surfaceId: assignment.surfaceId });
      continue;
    }
    const driver = drivers.get(assignment.driverId);
    if (!driver) {
      findings.push({ ruleId: "assignment-driver", detail: `unknown driver ${assignment.driverId}`, surfaceId: assignment.surfaceId });
      continue;
    }
    if (driver.kind !== surface.kind) {
      findings.push({ ruleId: "assignment-kind", detail: `driver kind ${driver.kind} does not match ${surface.kind}`, surfaceId: assignment.surfaceId });
    }
    const assignedPlatforms = surface.platforms.filter((platform) => driver.platforms?.[platform]);
    if (assignedPlatforms.length === 0) {
      findings.push({ ruleId: "assignment-platforms", detail: `driver ${driver.id} has no platform lane applicable to the surface`, surfaceId: assignment.surfaceId });
    }
    for (const platform of assignedPlatforms) {
      const key = assignmentCellKey(assignment.surfaceId, platform);
      if (assignments.has(key)) {
        findings.push({ ruleId: "assignment-duplicate", detail: `surface has more than one ${platform} driver assignment`, surfaceId: assignment.surfaceId });
        continue;
      }
      assignments.set(key, assignment);
    }
    const manifest = readyManifests.get(driver.id);
    const hasReadyPlatform = assignedPlatforms.some((platform) => driver.platforms?.[platform] === "ready");
    if (hasReadyPlatform && rootDir && manifest && !manifest.supportedFixtures.includes(assignment.fixtureId)) {
      findings.push({ ruleId: "assignment-fixture", detail: `ready driver ${driver.id} does not implement fixture ${assignment.fixtureId}`, surfaceId: assignment.surfaceId });
    }
    if (hasReadyPlatform && rootDir && manifest && !manifest.supportedCleanups.includes(assignment.cleanupId)) {
      findings.push({ ruleId: "assignment-cleanup", detail: `ready driver ${driver.id} does not implement cleanup ${assignment.cleanupId}`, surfaceId: assignment.surfaceId });
    }
    if (hasReadyPlatform && rootDir && manifest && !manifest.supportedOracles.includes(assignment.oracleId)) {
      findings.push({ ruleId: "assignment-oracle", detail: `ready driver ${driver.id} does not implement oracle ${assignment.oracleId}`, surfaceId: assignment.surfaceId });
    }
    for (const [field, value] of [
      ["fixtureId", assignment.fixtureId],
      ["expectedEffect", assignment.expectedEffect],
      ["oracleId", assignment.oracleId],
      ["cleanupId", assignment.cleanupId],
    ] as const) {
      if (!value?.trim()) findings.push({ ruleId: `assignment-${field}`, detail: `${field} is required`, surfaceId: assignment.surfaceId });
    }
    for (const detail of validateReleaseUiControlOracle(surface, assignment.oracleId ?? "")) {
      findings.push({ ruleId: "assignment-ui-oracle", detail, surfaceId: assignment.surfaceId });
    }
    const fieldsReady = driver.kind === surface.kind && assignment.fixtureId?.trim()
      && assignment.expectedEffect?.trim() && assignment.oracleId?.trim() && assignment.cleanupId?.trim();
    for (const platform of assignedPlatforms) {
      const driverIsExecutable = driver.platforms?.[platform] === "ready" && (!rootDir || readyManifests.has(driver.id));
      if (driverIsExecutable && fieldsReady && assignments.get(assignmentCellKey(assignment.surfaceId, platform)) === assignment) {
        ready += 1;
        readyByKind[surface.kind] += 1;
        readyByPlatform[platform] += 1;
      }
    }
  }

  const missing = inventoryCells - assignments.size;
  const structurallyInvalid = findings.length > 0;
  const complete = !structurallyInvalid && missing === 0 && ready === inventoryCells;
  if (plan.releaseReady !== complete) {
    findings.push({
      ruleId: "plan-release-ready",
      detail: complete
        ? "all surface-platform cells are ready but releaseReady is false"
        : "releaseReady cannot be true until every exact surface-platform cell has a ready driver, fixture, effect, and cleanup",
    });
  }
  return {
    status: findings.length > 0 ? "invalid" : complete ? "ready" : "building",
    findings,
    counts: {
      inventoryItems: inventory.items.length,
      inventoryCells,
      assigned: assignments.size,
      ready,
      missing,
      readyByKind,
      readyByPlatform,
    },
  };
}

export function assignmentCellKey(surfaceId: string, platform: ReleasePlatform): string {
  return `${platform}\0${surfaceId}`;
}

export function driverReadyOnPlatform(
  driver: FinalSurfaceDriverDefinition,
  platform: ReleasePlatform,
): boolean {
  return driver.platforms?.[platform] === "ready";
}

export function describeReadyDriver(
  rootDir: string,
  driver: FinalSurfaceDriverDefinition,
): ReleaseSurfaceDriverManifest | string {
  const path = resolve(rootDir, driver.entrypoint);
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return `ready driver ${driver.id} entrypoint must be a regular non-symlink file`;
  } catch (error) {
    return `ready driver ${driver.id} entrypoint is missing: ${error instanceof Error ? error.message : String(error)}`;
  }
  const result = spawnSync(process.execPath, releaseSurfaceControllerNodeArguments(path, ["--describe"]), {
    cwd: rootDir,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.status !== 0) return `ready driver ${driver.id} --describe failed: ${(result.stderr || result.stdout).trim()}`;
  let manifest: ReleaseSurfaceDriverManifest;
  try {
    manifest = JSON.parse(result.stdout) as ReleaseSurfaceDriverManifest;
  } catch {
    return `ready driver ${driver.id} --describe did not return one JSON manifest`;
  }
  if (manifest.schema !== RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA) return `ready driver ${driver.id} uses an unsupported manifest schema`;
  if (manifest.id !== driver.id) return `ready driver ${driver.id} describes itself as ${manifest.id}`;
  if (manifest.kind !== driver.kind) return `ready driver ${driver.id} describes kind ${manifest.kind}, expected ${driver.kind}`;
  if (manifest.runtimeBinding !== "attested-process") return `ready driver ${driver.id} does not require attested-process runtime binding`;
  if (!new Set([
    "native-webdriver",
    "native-installed-input",
    "native-installed-input-with-fixture-webdriver",
    "debug-api-direct",
    "debug-api-synthetic",
    "process-cli",
    "process-cli-with-fixture-webdriver",
  ]).has(manifest.invocationTransport)) {
    return `ready driver ${driver.id} does not declare a supported invocation transport`;
  }
  if (["ui-control", "palette-action", "keyboard-shortcut"].includes(driver.kind)
    && !new Set(["native-installed-input", "native-installed-input-with-fixture-webdriver"])
      .has(manifest.invocationTransport)) {
    return `ready user-action driver ${driver.id} must invoke through the platform-native installed-input transport`;
  }
  if (!Array.isArray(manifest.supportedFixtures) || manifest.supportedFixtures.length === 0) return `ready driver ${driver.id} declares no supported fixtures`;
  if (!Array.isArray(manifest.supportedCleanups) || manifest.supportedCleanups.length === 0) return `ready driver ${driver.id} declares no supported cleanups`;
  if (!Array.isArray(manifest.supportedOracles) || manifest.supportedOracles.length === 0) return `ready driver ${driver.id} declares no supported oracles`;
  if (manifest.controllerFiles !== undefined
    && (!Array.isArray(manifest.controllerFiles)
      || manifest.controllerFiles.some((controllerPath) => !isSafeRepositoryPath(controllerPath))
      || new Set(manifest.controllerFiles).size !== manifest.controllerFiles.length)) {
    return `ready driver ${driver.id} declares invalid controller files`;
  }
  if (manifest.maxAssignmentsPerProcess !== undefined
    && (!Number.isSafeInteger(manifest.maxAssignmentsPerProcess)
      || manifest.maxAssignmentsPerProcess < 1
      || manifest.maxAssignmentsPerProcess > 500)) {
    return `ready driver ${driver.id} declares an invalid assignment process bound`;
  }
  return manifest;
}

function emptyKindCounts(): Record<ReleaseSurfaceKind, number> {
  return {
    "tauri-command": 0,
    "debug-api-route": 0,
    "host-mcp-tool": 0,
    "browser-cli-command": 0,
    "palette-action": 0,
    "keyboard-shortcut": 0,
    "shellx-command": 0,
    "ui-debug-surface": 0,
    "ui-control": 0,
  };
}

function isSafeRepositoryPath(path: string | undefined): boolean {
  if (!path?.trim() || path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path)) return false;
  return !path.split(/[\\/]+/).some((segment) => segment === ".." || segment === "");
}
