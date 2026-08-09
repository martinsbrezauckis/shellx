import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FinalSurfaceContract } from "./release-surface-receipts";

export function discoverFinalSurfaceReceiptPaths(
  receiptsDir: string,
  contract: FinalSurfaceContract,
): string[] {
  const resolvedReceiptsDir = resolve(receiptsDir);
  const entries = new Set(readdirSync(resolvedReceiptsDir));
  return Object.keys(contract.platforms)
    .sort()
    .map((platform) => `${platform}-receipt.json`)
    .filter((basename) => entries.has(basename))
    .map((basename) => join(resolvedReceiptsDir, basename));
}
