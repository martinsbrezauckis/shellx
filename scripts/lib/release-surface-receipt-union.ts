import type { FinalSurfaceDriverPlan } from "./release-surface-driver-plan";
import type { FinalSurfaceReceipt } from "./release-surface-receipts";
import type { ReleasePlatform, ReleaseSurfaceInventory } from "./release-surface-inventory";
import {
  composeReleaseSurfaceOutcomeUnion,
  type ReleaseSurfaceOutcomeSlice,
} from "./release-surface-outcome-union";
import type { ReleaseSurfaceInterruptedRecovery } from "./release-surface-interrupted-recovery";

export interface ReleaseSurfaceValidatedReceiptSlice {
  sourceId: string;
  sourceKind: "complete-discovery" | "targeted-closure";
  receipt: FinalSurfaceReceipt;
}

export type ReleaseSurfaceValidatedUnionSlice =
  | { kind: "recovered"; recovery: ReleaseSurfaceInterruptedRecovery }
  | { kind: "receipt"; value: ReleaseSurfaceValidatedReceiptSlice };

export function composeValidatedReleaseSurfaceReceiptUnion(input: {
  inventory: ReleaseSurfaceInventory;
  driverPlan: FinalSurfaceDriverPlan;
  platform: ReleasePlatform;
  sourceCommit: string;
  version: string;
  slices: ReleaseSurfaceValidatedUnionSlice[];
  scenarioSourceId: string;
}): FinalSurfaceReceipt {
  if (input.slices.length === 0) throw new Error("final receipt union requires at least one validated slice");
  const sourceIds = new Set<string>();
  const evidenceArtifacts: FinalSurfaceReceipt["evidenceArtifacts"] = [];
  const evidenceIds = new Set<string>();
  const outcomeSlices: ReleaseSurfaceOutcomeSlice[] = [];
  let scenarioReceipt: FinalSurfaceReceipt | null = null;
  let artifact: FinalSurfaceReceipt["artifact"] | null = null;

  for (const entry of input.slices) {
    if (entry.kind === "recovered") {
      const recovery = entry.recovery;
      const sourceId = recovery.slice.sourceId;
      requireSourceId(sourceId, sourceIds);
      requireSliceIdentity(recovery.slice, input);
      requireArtifact(
        {
          basename: recovery.artifact.basename,
          sha256: recovery.artifact.sha256,
          signatureStatus: recovery.signatureStatus,
        },
        artifact,
      );
      artifact ??= {
        basename: recovery.artifact.basename,
        sha256: recovery.artifact.sha256,
        signatureStatus: recovery.signatureStatus,
      };
      const mapEvidence = evidenceNamespace(sourceId, recovery.evidenceArtifacts, evidenceArtifacts, evidenceIds);
      outcomeSlices.push({
        ...recovery.slice,
        outcomes: recovery.slice.outcomes.map((outcome) => ({
          ...outcome,
          evidenceId: requiredMappedEvidence(mapEvidence, outcome.evidenceId, sourceId),
          cleanupEvidenceId: requiredMappedEvidence(mapEvidence, outcome.cleanupEvidenceId, sourceId),
        })),
      });
      continue;
    }
    const { sourceId, sourceKind, receipt } = entry.value;
    requireSourceId(sourceId, sourceIds);
    requireReceiptIdentity(receipt, input);
    requireArtifact(receipt.artifact, artifact);
    artifact ??= { ...receipt.artifact };
    const mapEvidence = evidenceNamespace(sourceId, receipt.evidenceArtifacts, evidenceArtifacts, evidenceIds);
    const assignments = new Map(input.driverPlan.assignments.map((assignment) => [assignment.surfaceId, assignment]));
    outcomeSlices.push({
      sourceId,
      sourceKind,
      platform: receipt.platform,
      sourceCommit: receipt.sourceCommit,
      version: receipt.version,
      inventoryDigest: receipt.inventoryDigest,
      startedAt: receipt.startedAt,
      completedAt: receipt.completedAt,
      outcomes: receipt.outcomes.map((outcome) => {
        const assignment = assignments.get(outcome.id);
        if (!assignment) throw new Error(`validated receipt slice ${sourceId} contains unknown ${outcome.id}`);
        return {
          id: outcome.id,
          driverId: assignment.driverId,
          expectedEffect: outcome.expectedEffect,
          oracleId: outcome.oracleId,
          present: outcome.present,
          invoke: outcome.invoke,
          effect: outcome.effect,
          cleanup: outcome.cleanup,
          observedEffect: outcome.observedEffect,
          evidenceId: requiredMappedEvidence(mapEvidence, outcome.evidence, sourceId),
          cleanupEvidenceId: requiredMappedEvidence(mapEvidence, outcome.cleanupEvidence, sourceId),
        };
      }),
    });
    if (sourceId === input.scenarioSourceId) {
      if (!receipt.health.evidence || !mapEvidence.has(receipt.health.evidence)) {
        throw new Error("final receipt union scenario source has no validated scenario evidence");
      }
      scenarioReceipt = receipt;
    }
  }
  if (!artifact) throw new Error("final receipt union has no artifact identity");
  if (!scenarioReceipt) throw new Error("final receipt union scenario source is missing or is not a sealed receipt slice");
  const outcomeUnion = composeReleaseSurfaceOutcomeUnion({
    inventory: input.inventory,
    driverPlan: input.driverPlan,
    platform: input.platform,
    sourceCommit: input.sourceCommit,
    version: input.version,
    slices: outcomeSlices,
  });
  const scenarioPrefix = `${input.scenarioSourceId}:`;
  const scenarioEvidence = (id: string): string => {
    const mapped = `${scenarioPrefix}${id}`;
    if (!evidenceIds.has(mapped)) throw new Error(`scenario source references missing evidence ${id}`);
    return mapped;
  };
  return {
    schema: scenarioReceipt.schema,
    mode: "final-frozen-candidate",
    platform: input.platform,
    sourceCommit: input.sourceCommit,
    version: input.version,
    inventoryDigest: input.inventory.digest,
    startedAt: Date.parse(outcomeUnion.startedAt) < Date.parse(scenarioReceipt.startedAt)
      ? outcomeUnion.startedAt
      : scenarioReceipt.startedAt,
    completedAt: Date.parse(outcomeUnion.completedAt) > Date.parse(scenarioReceipt.completedAt)
      ? outcomeUnion.completedAt
      : scenarioReceipt.completedAt,
    artifact,
    evidenceArtifacts,
    transports: scenarioReceipt.transports.map((row) => ({ ...row, evidence: scenarioEvidence(row.evidence) })),
    providers: scenarioReceipt.providers.map((row) => ({ ...row, evidence: scenarioEvidence(row.evidence) })),
    providerRoutes: scenarioReceipt.providerRoutes.map((row) => ({ ...row, evidence: scenarioEvidence(row.evidence) })),
    health: { ...scenarioReceipt.health, evidence: scenarioEvidence(scenarioReceipt.health.evidence) },
    outcomes: outcomeUnion.selections.map((outcome) => ({
      id: outcome.id,
      expectedEffect: outcome.expectedEffect,
      oracleId: outcome.oracleId,
      present: "pass",
      invoke: "pass",
      effect: "pass",
      cleanup: "pass",
      evidence: outcome.evidenceId,
      cleanupEvidence: outcome.cleanupEvidenceId,
      observedEffect: outcome.observedEffect,
    })),
  };
}

function evidenceNamespace(
  sourceId: string,
  rows: Array<{ id: string; relativePath: string; sha256: string; bytes: number }>,
  target: FinalSurfaceReceipt["evidenceArtifacts"],
  ids: Set<string>,
): Map<string, string> {
  const mapping = new Map<string, string>();
  for (const row of rows) {
    const id = `${sourceId}:${row.id}`;
    if (mapping.has(row.id) || ids.has(id)) throw new Error(`final receipt union repeats evidence ${id}`);
    if (!/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.bytes) || row.bytes < 1) {
      throw new Error(`final receipt union evidence ${id} has invalid identity`);
    }
    mapping.set(row.id, id);
    ids.add(id);
    target.push({ id, relativePath: row.relativePath, sha256: row.sha256, bytes: row.bytes });
  }
  return mapping;
}

function requiredMappedEvidence(mapping: Map<string, string>, id: string, sourceId: string): string {
  const mapped = mapping.get(id);
  if (!mapped) throw new Error(`validated receipt slice ${sourceId} references missing evidence ${id}`);
  return mapped;
}

function requireSourceId(value: string, seen: Set<string>): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value) || seen.has(value)) {
    throw new Error(`final receipt union source id is invalid or duplicated: ${JSON.stringify(value)}`);
  }
  seen.add(value);
}

function requireSliceIdentity(
  slice: ReleaseSurfaceOutcomeSlice,
  input: Pick<Parameters<typeof composeValidatedReleaseSurfaceReceiptUnion>[0], "platform" | "sourceCommit" | "version" | "inventory">,
): void {
  if (slice.platform !== input.platform
    || slice.sourceCommit !== input.sourceCommit
    || slice.version !== input.version
    || slice.inventoryDigest !== input.inventory.digest) {
    throw new Error(`final receipt union source ${slice.sourceId} identity drifted`);
  }
}

function requireReceiptIdentity(
  receipt: FinalSurfaceReceipt,
  input: Pick<Parameters<typeof composeValidatedReleaseSurfaceReceiptUnion>[0], "platform" | "sourceCommit" | "version" | "inventory">,
): void {
  if (receipt.platform !== input.platform
    || receipt.sourceCommit !== input.sourceCommit
    || receipt.version !== input.version
    || receipt.inventoryDigest !== input.inventory.digest) {
    throw new Error("validated receipt slice identity drifted from the final union");
  }
}

function requireArtifact(
  candidate: FinalSurfaceReceipt["artifact"],
  current: FinalSurfaceReceipt["artifact"] | null,
): void {
  if (current && (candidate.basename !== current.basename
    || candidate.sha256 !== current.sha256
    || candidate.signatureStatus !== current.signatureStatus)) {
    throw new Error("final receipt union slices do not bind the same signed artifact");
  }
}
