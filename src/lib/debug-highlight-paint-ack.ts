export type DebugHighlightAnimationFrameScheduler = {
  request(callback: () => void): number;
  cancel(handle: number): void;
};

const browserAnimationFrames: DebugHighlightAnimationFrameScheduler = {
  request(callback) {
    return window.requestAnimationFrame(() => callback());
  },
  cancel(handle) {
    window.cancelAnimationFrame(handle);
  },
};

/**
 * A renderer receipt is useful to capture tooling only after the matching DOM
 * commit has had a paint opportunity. Two animation frames leave one browser
 * paint between the state commit and the acknowledgement; this is deliberately
 * not a clock-based delay.
 */
export function scheduleDebugHighlightPaintAcknowledgement(
  acknowledge: () => void,
  scheduler: DebugHighlightAnimationFrameScheduler = browserAnimationFrames,
): () => void {
  let cancelled = false;
  let firstFrame: number | null = scheduler.request(() => {
    firstFrame = null;
    if (cancelled) return;
    secondFrame = scheduler.request(() => {
      secondFrame = null;
      if (!cancelled) acknowledge();
    });
  });
  let secondFrame: number | null = null;
  return () => {
    cancelled = true;
    if (firstFrame !== null) scheduler.cancel(firstFrame);
    if (secondFrame !== null) scheduler.cancel(secondFrame);
  };
}
