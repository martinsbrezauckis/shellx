export interface HistoryDateRolloverClock {
  now: () => Date;
  setTimeout: (callback: () => void, delayMs: number) => number;
  clearTimeout: (timer: number) => void;
  onResume: (refresh: () => void) => () => void;
}

export function startHistoryDateRollover(
  clock: HistoryDateRolloverClock,
  onRefresh: (now: Date) => void,
): () => void {
  let timer: number | undefined;
  let stopped = false;
  const refresh = () => {
    if (stopped) return;
    const now = clock.now();
    onRefresh(now);
    if (timer !== undefined) clock.clearTimeout(timer);
    const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
    timer = clock.setTimeout(refresh, Math.max(1, nextMidnight - now.getTime() + 1));
  };
  const stopResume = clock.onResume(refresh);
  refresh();
  return () => {
    stopped = true;
    if (timer !== undefined) clock.clearTimeout(timer);
    stopResume();
  };
}
