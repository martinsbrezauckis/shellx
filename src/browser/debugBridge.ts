import type { DebugHighlightRequest } from "../components/DebugHighlightOverlay";
import { normalizeDebugHighlightRequests, sameDebugHighlightRequests } from "../lib/debug-highlight-normalization";

export function normalizeBrowserDebugSurface(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

export function normalizeBrowserDebugHighlights(value: unknown): DebugHighlightRequest[] | null {
  return normalizeDebugHighlightRequests(value);
}

export function sameBrowserDebugHighlights(a: DebugHighlightRequest[], b: DebugHighlightRequest[]): boolean {
  return sameDebugHighlightRequests(a, b);
}

function browserDebugTarget(payload: unknown): { selector: string; index: number; text: string | null } | null {
  if (typeof payload === "string") {
    return payload.trim() ? { selector: payload, index: 0, text: null } : null;
  }
  if (!payload || typeof payload !== "object") return null;
  const body = payload as Record<string, unknown>;
  const selector = typeof body.selector === "string" ? body.selector.trim() : "";
  if (!selector) return null;
  const index = typeof body.index === "number" && Number.isFinite(body.index)
    ? Math.max(0, Math.floor(body.index))
    : 0;
  const text = typeof body.text === "string" && body.text.length > 0 ? body.text : null;
  return { selector, index, text };
}

function findBrowserDebugElement(target: { selector: string; index: number; text: string | null }): HTMLElement | null {
  const candidates = Array.from(document.querySelectorAll(target.selector))
    .filter((node): node is HTMLElement => node instanceof HTMLElement);
  const text = target.text;
  return text
    ? candidates.find((node) => node.textContent?.includes(text)) ?? null
    : candidates[target.index] ?? null;
}

export function runBrowserDebugClickSelector(payload: unknown): void {
  const target = browserDebugTarget(payload);
  if (!target) return;
  window.requestAnimationFrame(() => {
    const element = findBrowserDebugElement(target);
    if (!element) return;
    element.scrollIntoView({ block: "center", inline: "center" });
    if (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")) {
      element.click();
      return;
    }
    element.click();
  });
}

export function runBrowserDebugInputSelector(payload: unknown): void {
  const target = browserDebugTarget(payload);
  if (!target || !payload || typeof payload !== "object") return;
  const body = payload as Record<string, unknown>;
  const value = typeof body.value === "string" ? body.value : "";
  const append = body.append === true;
  const key = typeof body.key === "string" && body.key.length > 0
    ? body.key
    : body.enter === true
      ? "Enter"
      : null;
  const blur = body.blur === true;
  window.requestAnimationFrame(() => {
    const element = findBrowserDebugElement(target);
    if (!element) return;
    element.scrollIntoView({ block: "center", inline: "center" });
    element.focus();
    const next = append && "value" in element
      ? `${String((element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value ?? "")}${value}`
      : value;
    if (element instanceof HTMLInputElement) {
      setNativeBrowserInputValue(element, next);
    } else if (element instanceof HTMLTextAreaElement) {
      setNativeBrowserTextAreaValue(element, next);
    } else if (element instanceof HTMLSelectElement) {
      setNativeBrowserSelectValue(element, next);
    } else if (element.isContentEditable) {
      element.textContent = next;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
    if (key) {
      element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      element.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
    }
    if (blur && "blur" in element && typeof element.blur === "function") {
      element.blur();
      element.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
      element.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    }
  });
}

export function runBrowserDebugDragSelector(payload: unknown): void {
  const target = browserDebugTarget(payload);
  if (!target || !payload || typeof payload !== "object") return;
  const body = payload as Record<string, unknown>;
  const dropTarget = typeof body.dropSelector === "string" && body.dropSelector.trim()
    ? {
        selector: body.dropSelector.trim(),
        index: typeof body.dropIndex === "number" && Number.isFinite(body.dropIndex) ? Math.max(0, Math.floor(body.dropIndex)) : 0,
        text: typeof body.dropText === "string" && body.dropText.length > 0 ? body.dropText : null,
      }
    : null;
  const mode = typeof body.mode === "string" ? body.mode.trim().toLowerCase() : "";
  const dx = typeof body.dx === "number" && Number.isFinite(body.dx) ? body.dx : 0;
  const dy = typeof body.dy === "number" && Number.isFinite(body.dy) ? body.dy : 0;
  const steps = typeof body.steps === "number" && Number.isFinite(body.steps)
    ? Math.min(20, Math.max(1, Math.floor(body.steps)))
    : 6;
  window.requestAnimationFrame(() => {
    const element = findBrowserDebugElement(target);
    if (!element) return;
    element.scrollIntoView({ block: "center", inline: "center" });
    const rect = element.getBoundingClientRect();
    const startX = typeof body.startX === "number" && Number.isFinite(body.startX) ? body.startX : rect.left + rect.width / 2;
    const startY = typeof body.startY === "number" && Number.isFinite(body.startY) ? body.startY : rect.top + rect.height / 2;
    const endX = typeof body.endX === "number" && Number.isFinite(body.endX) ? body.endX : startX + dx;
    const endY = typeof body.endY === "number" && Number.isFinite(body.endY) ? body.endY : startY + dy;
    if (dropTarget || mode === "html-dnd") {
      const pointedElement = document.elementFromPoint(endX, endY);
      const dropElement = dropTarget
        ? findBrowserDebugElement(dropTarget)
        : pointedElement instanceof HTMLElement
          ? pointedElement
          : null;
      if (!dropElement) return;
      const dataTransfer = createBrowserDebugDataTransfer();
      dispatchBrowserDebugDragEvent(element, "dragstart", startX, startY, dataTransfer);
      dispatchBrowserDebugDragEvent(dropElement, "dragenter", endX, endY, dataTransfer);
      dispatchBrowserDebugDragEvent(dropElement, "dragover", endX, endY, dataTransfer);
      dispatchBrowserDebugDragEvent(dropElement, "drop", endX, endY, dataTransfer);
      dispatchBrowserDebugDragEvent(element, "dragend", endX, endY, dataTransfer);
      return;
    }
    dispatchBrowserDebugPointer(element, "pointerdown", startX, startY, true);
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      dispatchBrowserDebugPointer(window, "pointermove", startX + (endX - startX) * t, startY + (endY - startY) * t, true);
    }
    dispatchBrowserDebugPointer(window, "pointerup", endX, endY, false);
  });
}

function createBrowserDebugDataTransfer(): DataTransfer {
  if (typeof DataTransfer === "function") return new DataTransfer();
  const values = new Map<string, string>();
  return {
    dropEffect: "move",
    effectAllowed: "all",
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    types: [] as unknown as readonly string[],
    clearData(format?: string) {
      if (format) values.delete(format);
      else values.clear();
    },
    getData(format: string) {
      return values.get(format) ?? "";
    },
    setData(format: string, data: string) {
      values.set(format, data);
    },
    setDragImage() {},
  } as DataTransfer;
}

function dispatchBrowserDebugDragEvent(
  target: HTMLElement,
  type: string,
  clientX: number,
  clientY: number,
  dataTransfer: DataTransfer,
): void {
  target.dispatchEvent(new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    dataTransfer,
  }));
}

function dispatchBrowserDebugPointer(target: Window | HTMLElement, type: string, clientX: number, clientY: number, pressed: boolean): void {
  const init = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX,
    clientY,
    button: 0,
    buttons: pressed ? 1 : 0,
  };
  const event = typeof PointerEvent === "function"
    ? new PointerEvent(type, { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true })
    : new MouseEvent(type, init);
  target.dispatchEvent(event);
}

function setNativeBrowserInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
}

function setNativeBrowserTextAreaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
}

function setNativeBrowserSelectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  setter?.call(select, value);
}
