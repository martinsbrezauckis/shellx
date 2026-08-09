export const MANUAL_ATLAS_PRODUCT_SOURCE_SCHEMA: "shellx/manual-atlas-product-source@1";

export function calculateManualAtlasProductSourceSha256(repoRoot: string): string;
export function calculateManualAtlasProductSourceSha256FromGit(
  repoRoot: string,
  sourceCommit: string,
): string;
export function isProductSourcePath(path: string): boolean;
