import type { FinalSurfaceDriverPlanVerification } from "./release-surface-driver-plan";

const LEDGER_MARKER = /<!-- shellx-final-surface-ledger: (\{[^\n]*\}) -->/g;

export function finalSurfaceLedgerStatus(
  verification: FinalSurfaceDriverPlanVerification,
): Record<string, number | string> {
  return {
    status: verification.status,
    inventoryItems: verification.counts.inventoryItems,
    inventoryCells: verification.counts.inventoryCells,
    assigned: verification.counts.assigned,
    ready: verification.counts.ready,
    missing: verification.counts.missing,
  };
}

export function finalSurfaceLedgerMarker(
  verification: FinalSurfaceDriverPlanVerification,
): string {
  return `<!-- shellx-final-surface-ledger: ${JSON.stringify(finalSurfaceLedgerStatus(verification))} -->`;
}

export function validateFinalSurfaceLedgerMarker(
  markdown: string,
  verification: FinalSurfaceDriverPlanVerification,
): string[] {
  const matches = [...markdown.matchAll(LEDGER_MARKER)];
  if (matches.length !== 1) {
    return ["FINAL_SURFACE_GATE.md must contain exactly one machine-bound surface-ledger marker"];
  }
  const expected = finalSurfaceLedgerMarker(verification);
  if (matches[0]?.[0] !== expected) {
    return [`FINAL_SURFACE_GATE.md surface-ledger marker drifted; expected ${expected}`];
  }
  return [];
}
