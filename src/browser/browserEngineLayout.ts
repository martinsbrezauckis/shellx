export interface BrowserEngineLayoutRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface BrowserEngineSyncBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const BROWSER_ENGINE_MIN_VISIBLE_EDGE = 16;
const BROWSER_ENGINE_PARKED_OFFSET = -30_000;
const BROWSER_ENGINE_PARKED_WIDTH = 1_024;
const BROWSER_ENGINE_PARKED_HEIGHT = 768;

export function browserEngineSyncBoundsForRect(rect: BrowserEngineLayoutRect): BrowserEngineSyncBounds {
  if (rect.width < BROWSER_ENGINE_MIN_VISIBLE_EDGE || rect.height < BROWSER_ENGINE_MIN_VISIBLE_EDGE) {
    return {
      x: BROWSER_ENGINE_PARKED_OFFSET,
      y: BROWSER_ENGINE_PARKED_OFFSET,
      width: BROWSER_ENGINE_PARKED_WIDTH,
      height: BROWSER_ENGINE_PARKED_HEIGHT,
    };
  }
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };
}
