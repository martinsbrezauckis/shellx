export interface ElementRect { left: number; top: number; width: number; height: number }
export interface ElementHitTest { xFraction: number; yFraction: number }
export interface ElementHitResult { x: number; y: number; matches: boolean }

/** Viewport geometry after ancestor scroll/paint clipping; never scrolls the UI. */
export function visibleElementRect(element: HTMLElement): ElementRect | null {
  const rect = element.getBoundingClientRect();
  const view = element.ownerDocument.defaultView;
  if (!view) return null;
  let left = Math.max(0, rect.left), top = Math.max(0, rect.top);
  let right = Math.min(view.innerWidth, rect.right), bottom = Math.min(view.innerHeight, rect.bottom);
  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  const own = view.getComputedStyle(element);
  if (own.visibility === "hidden" || own.visibility === "collapse") return null;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = view.getComputedStyle(node);
    if (style.display === "none" || Number(style.opacity) === 0 || style.contentVisibility === "hidden") return null;
    if (node !== element) {
      const bounds = node.getBoundingClientRect();
      // client dimensions exclude scrollbars/borders; account for axis scaling.
      const scaleX = node.offsetWidth > 0 ? bounds.width / node.offsetWidth : 1;
      const scaleY = node.offsetHeight > 0 ? bounds.height / node.offsetHeight : 1;
      const paintClip = /\b(paint|strict|content)\b/.test(style.contain);
      if (paintClip || ["auto", "scroll", "hidden", "clip"].includes(style.overflowX)) {
        left = Math.max(left, bounds.left + node.clientLeft * scaleX);
        right = Math.min(right, bounds.left + (node.clientLeft + node.clientWidth) * scaleX);
      }
      if (paintClip || ["auto", "scroll", "hidden", "clip"].includes(style.overflowY)) {
        top = Math.max(top, bounds.top + node.clientTop * scaleY);
        bottom = Math.min(bottom, bounds.top + (node.clientTop + node.clientHeight) * scaleY);
      }
    }
    if (!(right > left && bottom > top)) return null;
  }
  return { left, top, width: right - left, height: bottom - top };
}

/** Bind the exact pointer point to its current rendered hit target. */
export function hitTestElement(element: HTMLElement, rect: ElementRect, point: ElementHitTest): ElementHitResult | null {
  if (!validElementHitTest(point) || rect.width < 1 || rect.height < 1) return null;
  const x = rect.left + Math.max(0.5, Math.min(rect.width - 0.5, rect.width * point.xFraction));
  const y = rect.top + Math.max(0.5, Math.min(rect.height - 0.5, rect.height * point.yFraction));
  const hit = element.ownerDocument.elementFromPoint(x, y);
  return { x, y, matches: hit !== null && (hit === element || element.contains(hit)) };
}

export function validElementHitTest(value: unknown): value is ElementHitTest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const point = value as Record<string, unknown>;
  return Object.keys(point).sort().join(",") === "xFraction,yFraction"
    && [point.xFraction, point.yFraction].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1);
}
