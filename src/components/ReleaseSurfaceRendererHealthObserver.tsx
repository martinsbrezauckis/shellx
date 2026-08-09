import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

type DebugUiSnapshot = { releaseTestInstance?: unknown };

let activeObservers = 0;
let originalConsoleError: typeof console.error | null = null;

export function ReleaseSurfaceRendererHealthObserver() {
  useEffect(() => {
    let cancelled = false;
    let installed = false;
    void invoke<DebugUiSnapshot>("debug_ui_snapshot")
      .then((snapshot) => {
        if (cancelled || snapshot?.releaseTestInstance !== true) return;
        installReleaseHealthObserver();
        installed = true;
      })
      .catch(() => {
        // Plain-browser previews and builds without Debug API support do not
        // expose the snapshot command. They must remain unchanged.
      });
    return () => {
      cancelled = true;
      if (installed) uninstallReleaseHealthObserver();
    };
  }, []);
  return null;
}

function installReleaseHealthObserver(): void {
  activeObservers += 1;
  if (activeObservers !== 1) return;
  originalConsoleError = console.error.bind(console);
  console.error = (...values: unknown[]) => {
    recordRendererHealth("console-error", values.map(boundedValue).join(" ") || "console.error");
    originalConsoleError?.(...values);
  };
  window.addEventListener("error", onWindowError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
}

function uninstallReleaseHealthObserver(): void {
  activeObservers = Math.max(0, activeObservers - 1);
  if (activeObservers !== 0) return;
  if (originalConsoleError) console.error = originalConsoleError;
  originalConsoleError = null;
  window.removeEventListener("error", onWindowError);
  window.removeEventListener("unhandledrejection", onUnhandledRejection);
}

function onWindowError(event: ErrorEvent): void {
  recordRendererHealth(
    "window-error",
    boundedValue(event.error ?? event.message ?? "window error"),
    event.error instanceof Error ? event.error.stack : undefined,
  );
}

function onUnhandledRejection(event: PromiseRejectionEvent): void {
  const reason = event.reason;
  recordRendererHealth(
    "unhandled-rejection",
    boundedValue(reason ?? "unhandled rejection"),
    reason instanceof Error ? reason.stack : undefined,
  );
}

function recordRendererHealth(source: string, message: string, stack?: string): void {
  void invoke("renderer_error", {
    message: message.slice(0, 2_000),
    stack: stack?.slice(0, 8_000) ?? null,
    componentStack: `release-health:${source}`,
  }).catch(() => {
    // The observer is diagnostic-only and must never create a recursive
    // console failure when the native command surface is going away.
  });
}

function boundedValue(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 4_096);
  if (value instanceof Error) return (value.stack || value.message || String(value)).slice(0, 4_096);
  try {
    return JSON.stringify(value).slice(0, 4_096);
  } catch {
    return String(value).slice(0, 4_096);
  }
}
