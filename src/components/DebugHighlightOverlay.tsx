import { useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";

import { apiPost } from "../lib/debug-api";
import {
  normalizeDebugElementObservationFields,
  observeDebugElement,
  type DebugElementObservation,
  type DebugElementObservationField,
} from "../lib/debug-element-observation";

export interface DebugHighlightRequest {
  id?: string | null;
  selector: string;
  label?: string | null;
  color?: string | null;
  index?: number | null;
  text?: string | null;
  observe?: DebugElementObservationField[] | null;
}

export interface DebugHighlightRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface DebugHighlightResult {
  id: string;
  selector: string;
  label?: string | null;
  color: string;
  status: "resolved" | "missing" | "hidden" | "invalidSelector";
  message?: string | null;
  rect?: DebugHighlightRect | null;
  visibleRect?: DebugHighlightRect | null;
  clipped?: boolean;
  contentClipped?: boolean;
  viewportWidth?: number;
  viewportHeight?: number;
  observation?: DebugElementObservation | null;
}

interface RenderedHighlight extends Omit<DebugHighlightResult, "rect" | "visibleRect"> {
  rect: DebugHighlightRect;
  visibleRect: DebugHighlightRect;
  labelText: string;
  labelLeft: number;
  labelTop: number;
  labelPlacement: "above" | "below";
}

interface DebugHighlightOverlayProps {
  highlights: DebugHighlightRequest[];
  surface?: "app" | "browser";
}

const COLOR_MAP: Record<string, string> = {
  blue: "#1e88e5",
  green: "#43a047",
  red: "#e53935",
  yellow: "#f9a825",
  orange: "#fb8c00",
  cyan: "#00acc1",
  magenta: "#d81b60",
  white: "#f5f7fb",
};
const DEFAULT_HIGHLIGHT_COLOR = "#1e88e5";
const VIEWPORT_EDGE = 0;
const VIEWPORT_PADDING = 4;
const LABEL_WIDTH = 280;
const LABEL_HEIGHT = 28;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeColor(color: string | null | undefined): string {
  const trimmed = (color ?? "").trim();
  if (!trimmed) return DEFAULT_HIGHLIGHT_COLOR;
  const lowered = trimmed.toLowerCase();
  const named = COLOR_MAP[lowered];
  if (named) return named;
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed;
  if (/^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/i.test(trimmed)) return trimmed;
  return DEFAULT_HIGHLIGHT_COLOR;
}

function stableHighlightId(item: DebugHighlightRequest, index: number): string {
  const id = item.id?.trim();
  return id || `${item.selector || "highlight"}:${index}`;
}

function roundRect(rect: DOMRect): DebugHighlightRect {
  return {
    left: Math.round(rect.left * 10) / 10,
    top: Math.round(rect.top * 10) / 10,
    width: Math.round(rect.width * 10) / 10,
    height: Math.round(rect.height * 10) / 10,
  };
}

function roundPlainRect(rect: DebugHighlightRect): DebugHighlightRect {
  return {
    left: Math.round(rect.left * 10) / 10,
    top: Math.round(rect.top * 10) / 10,
    width: Math.round(rect.width * 10) / 10,
    height: Math.round(rect.height * 10) / 10,
  };
}

function visibleViewportRect(rect: DebugHighlightRect): DebugHighlightRect | null {
  const left = Math.max(rect.left, VIEWPORT_EDGE);
  const top = Math.max(rect.top, VIEWPORT_EDGE);
  const right = Math.min(rect.left + rect.width, window.innerWidth - VIEWPORT_EDGE);
  const bottom = Math.min(rect.top + rect.height, window.innerHeight - VIEWPORT_EDGE);
  if (right <= left || bottom <= top) return null;
  return roundPlainRect({
    left,
    top,
    width: right - left,
    height: bottom - top,
  });
}

function isClipped(rect: DebugHighlightRect, visibleRect: DebugHighlightRect): boolean {
  return (
    Math.abs(rect.left - visibleRect.left) > 0.1 ||
    Math.abs(rect.top - visibleRect.top) > 0.1 ||
    Math.abs(rect.width - visibleRect.width) > 0.1 ||
    Math.abs(rect.height - visibleRect.height) > 0.1
  );
}

function resolveTarget(item: DebugHighlightRequest): { element: HTMLElement | null; error?: string } {
  let matches: Element[];
  try {
    matches = Array.from(document.querySelectorAll(item.selector));
  } catch (err) {
    return { element: null, error: `invalid selector: ${err instanceof Error ? err.message : String(err)}` };
  }
  const textFilter = item.text?.trim();
  const elements = matches.filter((candidate): candidate is HTMLElement => {
    if (!(candidate instanceof HTMLElement)) return false;
    if (!textFilter) return true;
    return (candidate.textContent ?? "").includes(textFilter);
  });
  const index = Math.max(0, Math.trunc(item.index ?? 0));
  return { element: elements[index] ?? null };
}

function measureHighlights(highlights: DebugHighlightRequest[]): {
  rendered: RenderedHighlight[];
  results: DebugHighlightResult[];
} {
  const rendered: RenderedHighlight[] = [];
  const results: DebugHighlightResult[] = [];
  highlights.forEach((item, index) => {
    const id = stableHighlightId(item, index);
    const color = normalizeColor(item.color);
    const selector = item.selector?.trim() ?? "";
    const labelText = item.label?.trim() || id;
    if (!selector) {
      results.push({
        id,
        selector,
        label: item.label ?? null,
        color,
        status: "missing",
        message: "empty selector",
        rect: null,
      });
      return;
    }
    const { element, error } = resolveTarget({ ...item, selector });
    if (error) {
      results.push({
        id,
        selector,
        label: item.label ?? null,
        color,
        status: "invalidSelector",
        message: error,
        rect: null,
      });
      return;
    }
    if (!element) {
      results.push({
        id,
        selector,
        label: item.label ?? null,
        color,
        status: "missing",
        message: "selector did not match a visible HTMLElement",
        rect: null,
      });
      return;
    }
    const domRect = element.getBoundingClientRect();
    const rect = roundRect(domRect);
    if (rect.width <= 0 || rect.height <= 0) {
      results.push({
        id,
        selector,
        label: item.label ?? null,
        color,
        status: "hidden",
        message: "matched element has no visible size",
        rect,
        visibleRect: null,
      });
      return;
    }
    const observationFields = normalizeDebugElementObservationFields(item.observe);
    const visibleRect = visibleViewportRect(rect);
    if (!visibleRect) {
      const observation = element instanceof HTMLAnchorElement && observationFields.includes("href")
        ? observeDebugElement(element, ["href"])
        : undefined;
      results.push({
        id,
        selector,
        label: item.label ?? null,
        color,
        status: "hidden",
        message: "matched element is outside the visible viewport",
        rect,
        visibleRect: null,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        observation,
      });
      return;
    }
    const observation = observationFields.length > 0
      ? observeDebugElement(element, observationFields)
      : undefined;
    const clipped = isClipped(rect, visibleRect);
    const contentClipped = element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight;
    const aboveTop = visibleRect.top - LABEL_HEIGHT;
    const labelPlacement: "above" | "below" = aboveTop >= 4 ? "above" : "below";
    const unclampedLabelTop = labelPlacement === "above" ? aboveTop : visibleRect.top + visibleRect.height + 6;
    const labelTop = clamp(unclampedLabelTop, VIEWPORT_PADDING, window.innerHeight - LABEL_HEIGHT - VIEWPORT_PADDING);
    const labelLeft = clamp(visibleRect.left, VIEWPORT_PADDING, window.innerWidth - LABEL_WIDTH - VIEWPORT_PADDING);
    const result: RenderedHighlight = {
      id,
      selector,
      label: item.label ?? null,
      color,
      status: "resolved",
      rect,
      visibleRect,
      clipped,
      contentClipped,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      observation,
      labelText,
      labelLeft,
      labelTop,
      labelPlacement,
    };
    rendered.push(result);
    results.push({
      id,
      selector,
      label: item.label ?? null,
      color,
      status: "resolved",
      rect,
      visibleRect,
      clipped,
      contentClipped,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      observation,
    });
  });
  return { rendered, results };
}

export function DebugHighlightOverlay({ highlights, surface = "app" }: DebugHighlightOverlayProps): JSX.Element | null {
  const [rendered, setRendered] = useState<RenderedHighlight[]>([]);
  const [measurement, setMeasurement] = useState<{
    measuredHighlightsKey: string;
    results: DebugHighlightResult[];
  }>({ measuredHighlightsKey: "", results: [] });
  const lastReportRef = useRef<string>("");
  const highlightsKey = useMemo(() => JSON.stringify(highlights), [highlights]);
  const { measuredHighlightsKey, results } = measurement;

  useLayoutEffect(() => {
    let frame: number | null = null;
    const scheduleMeasure = () => {
      if (frame !== null) return;
      const requestedHighlightsKey = highlightsKey;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const measured = measureHighlights(highlights);
        setRendered(measured.rendered);
        setMeasurement({
          measuredHighlightsKey: requestedHighlightsKey,
          results: measured.results,
        });
      });
    };

    scheduleMeasure();
    window.addEventListener("resize", scheduleMeasure);
    window.addEventListener("scroll", scheduleMeasure, true);
    const mutationObserver = new MutationObserver(scheduleMeasure);
    mutationObserver.observe(document.body, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    const resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(document.documentElement);
    resizeObserver.observe(document.body);

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", scheduleMeasure);
      window.removeEventListener("scroll", scheduleMeasure, true);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, [highlightsKey, highlights]);

  useLayoutEffect(() => {
    if (measuredHighlightsKey !== highlightsKey) return;
    const key = `${surface}:${highlightsKey}:${JSON.stringify(results)}`;
    if (lastReportRef.current === key) return;
    lastReportRef.current = key;
    void apiPost("/state/ui", {
      debugSurface: surface,
      debugHighlightResults: results,
      source: "renderer",
    }).catch(() => {
      /* debug API may be disabled while running browser-only previews */
    });
  }, [highlightsKey, measuredHighlightsKey, results, surface]);

  if (highlights.length === 0 && rendered.length === 0) return null;

  return (
    <div className="debug-highlight-overlay-root" aria-hidden="true">
      {rendered.map((item) => (
        <div key={item.id}>
          <div
            className="debug-highlight-box"
            style={{
              left: item.visibleRect.left,
              top: item.visibleRect.top,
              width: item.visibleRect.width,
              height: item.visibleRect.height,
              borderColor: item.color,
            }}
          />
          <div
            className={`debug-highlight-label debug-highlight-label-${item.labelPlacement}`}
            style={{
              left: item.labelLeft,
              top: item.labelTop,
              borderColor: item.color,
              backgroundColor: item.color,
            }}
          >
            {item.labelText}
          </div>
        </div>
      ))}
    </div>
  );
}
