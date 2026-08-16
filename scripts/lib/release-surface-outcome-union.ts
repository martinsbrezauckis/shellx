import type { FinalSurfaceDriverPlan } from "./release-surface-driver-plan";
import type { ReleasePlatform, ReleaseSurfaceInventory } from "./release-surface-inventory";

export const RELEASE_SURFACE_OUTCOME_UNION_SCHEMA = "shellx/release-surface-outcome-union@1";

export type ReleaseSurfaceSliceVerdict = "pass" | "fail";

export interface ReleaseSurfaceSliceOutcome {
  id: string;
  driverId: string;
  expectedEffect: string;
  oracleId: string;
  present: ReleaseSurfaceSliceVerdict;
  invoke: ReleaseSurfaceSliceVerdict;
  effect: ReleaseSurfaceSliceVerdict;
  cleanup: ReleaseSurfaceSliceVerdict;
  observedEffect: string;
  evidenceId: string;
  cleanupEvidenceId: string;
}

export interface ReleaseSurfaceOutcomeSlice {
  sourceId: string;
  sourceKind: "interrupted-discovery" | "complete-discovery" | "targeted-closure";
  platform: ReleasePlatform;
  sourceCommit: string;
  version: string;
  inventoryDigest: string;
  startedAt: string;
  completedAt: string;
  outcomes: ReleaseSurfaceSliceOutcome[];
}

export interface ReleaseSurfaceOutcomeUnion {
  schema: typeof RELEASE_SURFACE_OUTCOME_UNION_SCHEMA;
  platform: ReleasePlatform;
  sourceCommit: string;
  version: string;
  inventoryDigest: string;
  startedAt: string;
  completedAt: string;
  sources: Array<{
    sourceId: string;
    sourceKind: ReleaseSurfaceOutcomeSlice["sourceKind"];
    startedAt: string;
    completedAt: string;
    outcomeCount: number;
  }>;
  selections: Array<ReleaseSurfaceSliceOutcome & { sourceId: string }>;
  retainedFailures: Array<{
    sourceId: string;
    id: string;
    driverId: string;
    evidenceId: string;
    cleanupEvidenceId: string;
  }>;
}

export function composeReleaseSurfaceOutcomeUnion(input: {
  inventory: ReleaseSurfaceInventory;
  driverPlan: FinalSurfaceDriverPlan;
  platform: ReleasePlatform;
  sourceCommit: string;
  version: string;
  slices: ReleaseSurfaceOutcomeSlice[];
}): ReleaseSurfaceOutcomeUnion {
  if (input.slices.length === 0) throw new Error("release surface union requires at least one evidence slice");
  const inventoryById = new Map(input.inventory.items.map((surface) => [surface.id, surface]));
  const assignmentsByCell = new Map(input.driverPlan.assignments.map((assignment) => [
    `${assignment.surfaceId}\0${input.platform}`,
    assignment,
  ]));
  const applicableIds = input.inventory.items
    .filter((surface) => surface.platforms.includes(input.platform))
    .map((surface) => surface.id)
    .sort();
  const applicableSet = new Set(applicableIds);
  const sourceIds = new Set<string>();
  const observations = new Map<string, Array<ReleaseSurfaceSliceOutcome & {
    sourceId: string;
    sourceKind: ReleaseSurfaceOutcomeSlice["sourceKind"];
    completedAt: string;
    sourceOrder: number;
  }>>();

  for (const [sourceOrder, slice] of input.slices.entries()) {
    requireSourceIdentity(slice, input);
    if (!validSourceId(slice.sourceId) || sourceIds.has(slice.sourceId)) {
      throw new Error(`release surface union source id is invalid or duplicated: ${JSON.stringify(slice.sourceId)}`);
    }
    sourceIds.add(slice.sourceId);
    if (!validIsoRange(slice.startedAt, slice.completedAt)) {
      throw new Error(`release surface union source ${slice.sourceId} has invalid timestamps`);
    }
    if (slice.outcomes.length === 0) {
      throw new Error(`release surface union source ${slice.sourceId} has no durable outcomes`);
    }
    const seenInSource = new Set<string>();
    for (const outcome of slice.outcomes) {
      if (seenInSource.has(outcome.id)) {
        throw new Error(`release surface union source ${slice.sourceId} repeats ${outcome.id}`);
      }
      seenInSource.add(outcome.id);
      validateOutcome(outcome, slice, inventoryById, assignmentsByCell, applicableSet);
      const rows = observations.get(outcome.id) ?? [];
      rows.push({
        ...outcome,
        sourceId: slice.sourceId,
        sourceKind: slice.sourceKind,
        completedAt: slice.completedAt,
        sourceOrder,
      });
      observations.set(outcome.id, rows);
    }
  }

  const missing = applicableIds.filter((id) => !observations.has(id));
  if (missing.length > 0) {
    throw new Error(`release surface union is missing ${missing.length} outcomes; first: ${missing.slice(0, 5).join(", ")}`);
  }
  const selections: ReleaseSurfaceOutcomeUnion["selections"] = [];
  const retainedFailures: ReleaseSurfaceOutcomeUnion["retainedFailures"] = [];
  for (const id of applicableIds) {
    const rows = observations.get(id)!;
    rows.sort(compareObservation);
    for (const row of rows) {
      if (!outcomePassed(row)) {
        retainedFailures.push({
          sourceId: row.sourceId,
          id: row.id,
          driverId: row.driverId,
          evidenceId: row.evidenceId,
          cleanupEvidenceId: row.cleanupEvidenceId,
        });
      }
    }
    const selected = rows.at(-1)!;
    if (!outcomePassed(selected)) {
      throw new Error(`release surface union latest evidence for ${id} is not passing (${selected.sourceId})`);
    }
    selections.push({
      id: selected.id,
      driverId: selected.driverId,
      expectedEffect: selected.expectedEffect,
      oracleId: selected.oracleId,
      present: selected.present,
      invoke: selected.invoke,
      effect: selected.effect,
      cleanup: selected.cleanup,
      observedEffect: selected.observedEffect,
      evidenceId: selected.evidenceId,
      cleanupEvidenceId: selected.cleanupEvidenceId,
      sourceId: selected.sourceId,
    });
  }
  const startedAt = input.slices.reduce(
    (earliest, slice) => Date.parse(slice.startedAt) < Date.parse(earliest) ? slice.startedAt : earliest,
    input.slices[0]!.startedAt,
  );
  const completedAt = input.slices.reduce(
    (latest, slice) => Date.parse(slice.completedAt) > Date.parse(latest) ? slice.completedAt : latest,
    input.slices[0]!.completedAt,
  );
  return {
    schema: RELEASE_SURFACE_OUTCOME_UNION_SCHEMA,
    platform: input.platform,
    sourceCommit: input.sourceCommit,
    version: input.version,
    inventoryDigest: input.inventory.digest,
    startedAt,
    completedAt,
    sources: input.slices.map((slice) => ({
      sourceId: slice.sourceId,
      sourceKind: slice.sourceKind,
      startedAt: slice.startedAt,
      completedAt: slice.completedAt,
      outcomeCount: slice.outcomes.length,
    })),
    selections,
    retainedFailures,
  };
}

function requireSourceIdentity(
  slice: ReleaseSurfaceOutcomeSlice,
  input: Pick<Parameters<typeof composeReleaseSurfaceOutcomeUnion>[0], "platform" | "sourceCommit" | "version" | "inventory">,
): void {
  for (const [field, expected, actual] of [
    ["platform", input.platform, slice.platform],
    ["sourceCommit", input.sourceCommit, slice.sourceCommit],
    ["version", input.version, slice.version],
    ["inventoryDigest", input.inventory.digest, slice.inventoryDigest],
  ] as const) {
    if (actual !== expected) throw new Error(`release surface union source ${slice.sourceId} ${field} drifted`);
  }
}

function validateOutcome(
  outcome: ReleaseSurfaceSliceOutcome,
  slice: ReleaseSurfaceOutcomeSlice,
  inventoryById: Map<string, ReleaseSurfaceInventory["items"][number]>,
  assignmentsByCell: Map<string, FinalSurfaceDriverPlan["assignments"][number]>,
  applicableIds: Set<string>,
): void {
  const surface = inventoryById.get(outcome.id);
  const assignment = assignmentsByCell.get(`${outcome.id}\0${slice.platform}`);
  if (!surface || !applicableIds.has(outcome.id) || !assignment) {
    throw new Error(`release surface union source ${slice.sourceId} contains unknown outcome ${outcome.id}`);
  }
  if (assignment.driverId !== outcome.driverId
    || assignment.expectedEffect !== outcome.expectedEffect
    || assignment.oracleId !== outcome.oracleId) {
    throw new Error(`release surface union source ${slice.sourceId} outcome ${outcome.id} drifted from the frozen plan`);
  }
  for (const [field, value] of [
    ["present", outcome.present],
    ["invoke", outcome.invoke],
    ["effect", outcome.effect],
    ["cleanup", outcome.cleanup],
  ] as const) {
    if (value !== "pass" && value !== "fail") {
      throw new Error(`release surface union source ${slice.sourceId} outcome ${outcome.id} has invalid ${field}`);
    }
  }
  if (!boundedText(outcome.observedEffect, 4_096)
    || !validEvidenceId(outcome.evidenceId)
    || !validEvidenceId(outcome.cleanupEvidenceId)) {
    throw new Error(`release surface union source ${slice.sourceId} outcome ${outcome.id} has invalid evidence fields`);
  }
}

function compareObservation(
  left: { completedAt: string; sourceOrder: number },
  right: { completedAt: string; sourceOrder: number },
): number {
  const time = Date.parse(left.completedAt) - Date.parse(right.completedAt);
  if (time !== 0) return time;
  return left.sourceOrder - right.sourceOrder;
}

function outcomePassed(outcome: ReleaseSurfaceSliceOutcome): boolean {
  return outcome.present === "pass"
    && outcome.invoke === "pass"
    && outcome.effect === "pass"
    && outcome.cleanup === "pass";
}

function validSourceId(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,127}$/.test(value);
}

function validEvidenceId(value: string): boolean {
  return /^[a-z0-9][a-z0-9._:-]{0,255}$/.test(value);
}

function boundedText(value: string, max: number): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\0\r]/.test(value);
}

function validIsoRange(startedAt: string, completedAt: string): boolean {
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start;
}
