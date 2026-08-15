export function releaseSourceOnlyRequested(
  value = process.env.SHELLX_RELEASE_SOURCE_ONLY,
): boolean {
  const normalized = value?.trim() ?? "";
  if (!normalized) return false;
  if (normalized !== "1") {
    throw new Error("SHELLX_RELEASE_SOURCE_ONLY must be exactly 1 when source-only qualification is requested");
  }
  return true;
}
