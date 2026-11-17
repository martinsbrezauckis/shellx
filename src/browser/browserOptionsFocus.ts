/** Closing the sidecar restores its opener only when focus was inside it. */
export function shouldRestoreBrowserOptionsFocus(
  sidecar: Pick<Element, "contains"> | null,
  activeElement: Element | null,
): boolean {
  return Boolean(sidecar && activeElement && sidecar.contains(activeElement));
}

export function closeBrowserOptionsWithFocus(setOptionsOpen: (open: boolean) => void): void {
  const sidecar = document.getElementById("shellx-browser-options-sidecar");
  const shouldRestore = shouldRestoreBrowserOptionsFocus(sidecar, document.activeElement);
  setOptionsOpen(false);
  if (shouldRestore) {
    window.requestAnimationFrame(() => {
      document.getElementById("shellx-browser-options")?.focus({ preventScroll: true });
    });
  }
}
