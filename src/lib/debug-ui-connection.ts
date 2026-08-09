export type DebugUiConnectionStatus = "connecting" | "connected" | "disconnected";

export const DEBUG_UI_RETRY_MIN_MS = 1_000;
export const DEBUG_UI_RETRY_MAX_MS = 30_000;
export const DEBUG_UI_RETRY_JITTER = 0.2;
export const DEBUG_UI_CONNECT_TIMEOUT_MS = 5_000;
export const DEBUG_UI_POLL_MS = 1_000;
export const DEBUG_UI_DISCONNECTED_POLL_MS = 5_000;

export function debugUiRetryDelay(attempt: number, random: () => number = Math.random): number {
  const normalizedAttempt = Number.isFinite(attempt)
    ? Math.max(0, Math.min(30, Math.trunc(attempt)))
    : 0;
  const exponential = Math.min(DEBUG_UI_RETRY_MAX_MS, DEBUG_UI_RETRY_MIN_MS * (2 ** normalizedAttempt));
  const randomValue = random();
  const sample = Number.isFinite(randomValue) ? Math.max(0, Math.min(1, randomValue)) : 0.5;
  const jittered = exponential * (1 - DEBUG_UI_RETRY_JITTER + (2 * DEBUG_UI_RETRY_JITTER * sample));
  return Math.max(1, Math.min(DEBUG_UI_RETRY_MAX_MS, Math.round(jittered)));
}

export function debugUiPollingEnabled(status: DebugUiConnectionStatus): boolean {
  return status !== "connecting";
}

export function debugUiPollDelay(status: DebugUiConnectionStatus): number {
  return status === "connected" ? DEBUG_UI_POLL_MS : DEBUG_UI_DISCONNECTED_POLL_MS;
}
