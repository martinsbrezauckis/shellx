import { isPublicManualPreview } from "./public-manual-mode";

export { isPublicManualPreview } from "./public-manual-mode";

export const PUBLIC_MANUAL_PREVIEW_SCHEMA = "shellx.public-manual-preview.v1";

export type PublicManualHighlightColor = "blue" | "cyan" | "green" | "magenta" | "orange" | "yellow";

export interface PublicManualPreviewRequest {
  readonly schema: typeof PUBLIC_MANUAL_PREVIEW_SCHEMA;
  readonly kind: "show-state";
  readonly featureId: string;
  readonly stateId: string;
  readonly focusDebugId?: string;
  readonly highlightLabel?: string;
  readonly highlightColor?: PublicManualHighlightColor;
}

export interface PublicManualControlMessage {
  readonly schema: typeof PUBLIC_MANUAL_PREVIEW_SCHEMA;
  readonly kind: "control";
  readonly debugId: string;
}

export interface PublicManualReadyMessage {
  readonly schema: typeof PUBLIC_MANUAL_PREVIEW_SCHEMA;
  readonly kind: "ready";
}

const FEATURE_ID = /^shellx\.[a-z0-9_.-]{1,180}$/;
const STATE_ID = /^[a-z][a-z0-9-]{1,80}$/;
const DEBUG_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const HIGHLIGHT_LABEL = /^.{1,80}$/s;
const HIGHLIGHT_COLORS = new Set<PublicManualHighlightColor>(["blue", "cyan", "green", "magenta", "orange", "yellow"]);

export function parsePublicManualPreviewRequest(value: unknown): PublicManualPreviewRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schema !== PUBLIC_MANUAL_PREVIEW_SCHEMA || record.kind !== "show-state") return null;
  if (typeof record.featureId !== "string" || !FEATURE_ID.test(record.featureId)) return null;
  if (typeof record.stateId !== "string" || !STATE_ID.test(record.stateId)) return null;
  if (record.focusDebugId !== undefined && (typeof record.focusDebugId !== "string" || !DEBUG_ID.test(record.focusDebugId))) return null;
  if (record.highlightLabel !== undefined && (typeof record.highlightLabel !== "string" || !HIGHLIGHT_LABEL.test(record.highlightLabel))) return null;
  if (record.highlightColor !== undefined && (
    typeof record.highlightColor !== "string"
    || !HIGHLIGHT_COLORS.has(record.highlightColor as PublicManualHighlightColor)
  )) return null;
  return {
    schema: PUBLIC_MANUAL_PREVIEW_SCHEMA,
    kind: "show-state",
    featureId: record.featureId,
    stateId: record.stateId,
    ...(record.focusDebugId ? { focusDebugId: record.focusDebugId } : {}),
    ...(record.highlightLabel ? { highlightLabel: record.highlightLabel } : {}),
    ...(record.highlightColor ? { highlightColor: record.highlightColor as PublicManualHighlightColor } : {}),
  };
}

export function isTrustedPublicManualParentMessage(event: MessageEvent): boolean {
  if (!isPublicManualPreview() || window.parent === window) return false;
  if (event.source !== window.parent) return false;
  return event.origin === window.location.origin;
}

/**
 * Report the exact production-owned control a reader clicked. The parent uses
 * this only to select documentation; no DOM selector or action is accepted in
 * the reverse direction.
 */
export function installPublicManualControlReporter(): () => void {
  if (!isPublicManualPreview() || window.parent === window) return () => undefined;
  const report = (event: Event): void => {
    const element = event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-debug-id]")
      : null;
    const debugId = element?.dataset.debugId;
    if (!debugId || !DEBUG_ID.test(debugId)) return;
    const message: PublicManualControlMessage = {
      schema: PUBLIC_MANUAL_PREVIEW_SCHEMA,
      kind: "control",
      debugId,
    };
    window.parent.postMessage(message, window.location.origin);
  };
  document.addEventListener("click", report, true);
  return () => document.removeEventListener("click", report, true);
}

/**
 * Tell the same-origin guide that the production component has installed its
 * bounded state listener. A frame load alone is too early: React effects may
 * not yet be ready to receive the initial selection.
 */
export function notifyPublicManualPreviewReady(): void {
  if (!isPublicManualPreview() || window.parent === window) return;
  const message: PublicManualReadyMessage = {
    schema: PUBLIC_MANUAL_PREVIEW_SCHEMA,
    kind: "ready",
  };
  window.parent.postMessage(message, window.location.origin);
}
