export type BrowserHistoryDateFilter = "all" | "today" | "yesterday" | "last7";

export function historyMatchesDateFilter(
  visitedAtMs: number,
  filter: BrowserHistoryDateFilter,
  now: Date = new Date(),
): boolean {
  if (filter === "all") return true;
  if (!Number.isFinite(visitedAtMs) || visitedAtMs <= 0) return false;
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  // Local calendar days can be shorter or longer than 24 hours across DST.
  const startYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  if (filter === "today") return visitedAtMs >= startToday;
  if (filter === "yesterday") return visitedAtMs >= startYesterday && visitedAtMs < startToday;
  const startLast7 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime();
  return visitedAtMs >= startLast7;
}
