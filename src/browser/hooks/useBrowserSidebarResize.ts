import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type KeyboardEvent,
  type PointerEvent,
  type SetStateAction,
} from "react";

const MIN_SIDEBAR_WIDTH = 280;
const MAX_SIDEBAR_WIDTH = 560;
const KEYBOARD_RESIZE_STEP = 20;

function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

export function useBrowserSidebarResize(
  width: number,
  setWidth: Dispatch<SetStateAction<number>>,
): {
  startRightSidebarResize: (event: PointerEvent<HTMLButtonElement>) => void;
  resizeRightSidebarFromKeyboard: (event: KeyboardEvent<HTMLButtonElement>) => void;
} {
  const cleanupRef = useRef<() => void>(() => undefined);
  useEffect(() => () => cleanupRef.current(), []);

  const startRightSidebarResize = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    cleanupRef.current();
    const startX = event.clientX;
    const startWidth = width;
    const onPointerMove = (moveEvent: globalThis.PointerEvent) => {
      setWidth(clampSidebarWidth(startWidth - (moveEvent.clientX - startX)));
    };
    const stopResize = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      cleanupRef.current = () => undefined;
    };
    cleanupRef.current = stopResize;
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  }, [setWidth, width]);

  const resizeRightSidebarFromKeyboard = useCallback((event: KeyboardEvent<HTMLButtonElement>) => {
    const delta = event.key === "ArrowLeft"
      ? KEYBOARD_RESIZE_STEP
      : event.key === "ArrowRight"
        ? -KEYBOARD_RESIZE_STEP
        : 0;
    if (delta === 0) return;
    event.preventDefault();
    setWidth((current) => clampSidebarWidth(current + delta));
  }, [setWidth]);

  return { startRightSidebarResize, resizeRightSidebarFromKeyboard };
}
