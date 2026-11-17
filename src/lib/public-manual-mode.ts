/** True only inside a dedicated static public-manual entry. */
export function isPublicManualPreview(): boolean {
  return typeof document !== "undefined"
    && document.documentElement.dataset.shellxPublicManualPreview === "true";
}
