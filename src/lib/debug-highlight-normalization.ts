import type { DebugHighlightRequest } from "../components/DebugHighlightOverlay";
import { normalizeDebugElementObservationFields } from "./debug-element-observation";

export function normalizeDebugHighlightRequests(value: unknown): DebugHighlightRequest[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .map((entry): DebugHighlightRequest | null => {
      if (!entry || typeof entry !== "object") return null;
      const body = entry as Record<string, unknown>;
      const selector = typeof body.selector === "string" ? body.selector.trim() : "";
      if (!selector) return null;
      const normalized: DebugHighlightRequest = { selector };
      if (typeof body.id === "string" && body.id.trim()) normalized.id = body.id.trim();
      if (typeof body.label === "string" && body.label.trim()) normalized.label = body.label.trim();
      if (typeof body.color === "string" && body.color.trim()) normalized.color = body.color.trim();
      if (typeof body.text === "string" && body.text.trim()) normalized.text = body.text.trim();
      if (typeof body.index === "number" && Number.isFinite(body.index)) {
        normalized.index = Math.max(0, Math.floor(body.index));
      }
      const observe = normalizeDebugElementObservationFields(body.observe);
      if (observe.length > 0) normalized.observe = observe;
      return normalized;
    })
    .filter((entry): entry is DebugHighlightRequest => entry !== null)
    .slice(0, 24);
}

export function sameDebugHighlightRequests(a: DebugHighlightRequest[], b: DebugHighlightRequest[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
