import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ReleasePlatform } from "./release-surface-inventory";
import type { FinalSurfaceReceipt } from "./release-surface-receipts";

export interface ReleaseSurfaceEvidenceFileVerification {
  verified: Partial<Record<ReleasePlatform, string[]>>;
  errors: string[];
}

export function verifyReleaseSurfaceEvidenceFiles(
  receiptsRoot: string,
  receipts: FinalSurfaceReceipt[],
): ReleaseSurfaceEvidenceFileVerification {
  const root = realpathSync(receiptsRoot);
  const verified = new Map<ReleasePlatform, Set<string>>();
  const errors: string[] = [];
  for (const receipt of receipts) {
    const ids = verified.get(receipt.platform) ?? new Set<string>();
    verified.set(receipt.platform, ids);
    for (const artifact of receipt.evidenceArtifacts ?? []) {
      const label = `${receipt.platform}:${artifact.id || "missing-id"}`;
      try {
        if (!artifact.relativePath?.trim() || isAbsolute(artifact.relativePath)) {
          throw new Error("path must be relative");
        }
        const candidate = resolve(root, artifact.relativePath);
        if (!isWithin(root, candidate)) throw new Error("path escapes receipts directory");
        const stat = lstatSync(candidate);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new Error("path must be a regular non-symlink file");
        }
        const real = realpathSync(candidate);
        if (!isWithin(root, real)) throw new Error("real path escapes receipts directory");
        const bytes = readFileSync(real);
        if (bytes.length !== artifact.bytes) {
          throw new Error(`byte count mismatch: expected ${artifact.bytes}, got ${bytes.length}`);
        }
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        if (sha256 !== artifact.sha256.toLowerCase()) {
          throw new Error(`sha256 mismatch: expected ${artifact.sha256}, got ${sha256}`);
        }
        ids.add(artifact.id);
      } catch (error) {
        errors.push(`${label} ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return {
    verified: Object.fromEntries([...verified].map(([platform, ids]) => [platform, [...ids].sort()])),
    errors,
  };
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}
