import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function visibleFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => element.tabIndex >= 0
      && element.getClientRects().length > 0
      && element.getAttribute("aria-hidden") !== "true");
}

function inertOutsideDialog(dialog: HTMLElement): () => void {
  const changed: Array<{ element: HTMLElement; inert: boolean; ariaHidden: string | null }> = [];
  let kept: HTMLElement = dialog;
  let parent = kept.parentElement;
  while (parent && parent !== document.documentElement) {
    for (const child of Array.from(parent.children)) {
      if (child === kept || !(child instanceof HTMLElement)) continue;
      changed.push({ element: child, inert: child.inert, ariaHidden: child.getAttribute("aria-hidden") });
      child.inert = true;
      child.setAttribute("aria-hidden", "true");
    }
    kept = parent;
    parent = parent.parentElement;
  }
  return () => {
    for (const { element, inert, ariaHidden } of changed.reverse()) {
      element.inert = inert;
      if (ariaHidden === null) element.removeAttribute("aria-hidden");
      else element.setAttribute("aria-hidden", ariaHidden);
    }
  };
}

/** Adds initial focus, Tab containment, background inerting, Escape, and focus restoration. */
export function useModalFocus(
  open: boolean,
  dialogRef: RefObject<HTMLElement | null>,
  onClose: (event: KeyboardEvent) => void,
): void {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const restoreBackground = inertOutsideDialog(dialog);
    const focusFrame = window.requestAnimationFrame(() => {
      const preferred = dialog.querySelector<HTMLElement>('[data-dialog-initial-focus="true"]');
      (preferred ?? visibleFocusableElements(dialog)[0] ?? dialog).focus({ preventScroll: true });
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current(event);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = visibleFocusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
      const nextIndex = event.shiftKey
        ? activeIndex <= 0 ? focusable.length - 1 : activeIndex - 1
        : activeIndex < 0 || activeIndex === focusable.length - 1 ? 0 : activeIndex + 1;
      event.preventDefault();
      focusable[nextIndex]!.focus({ preventScroll: true });
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown, true);
      restoreBackground();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [dialogRef, open]);
}
