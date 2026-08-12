import type { BrowserHistoryEntry } from "./types";
import { USER_DEFAULT_PROFILE_ID } from "./browserAppConstants";

export type BrowserHistoryScope = "user" | "agent" | "all";
export type BrowserHistoryClass = Exclude<BrowserHistoryScope, "all">;

export function browserHistoryScopeForEntry(entry: BrowserHistoryEntry): BrowserHistoryClass {
  return entry.profileId === USER_DEFAULT_PROFILE_ID && !entry.taskId?.trim() ? "user" : "agent";
}

export function browserHistoryMatchesScope(scope: BrowserHistoryScope, entry: BrowserHistoryEntry): boolean {
  return scope === "all" || browserHistoryScopeForEntry(entry) === scope;
}

export function browserHistoryEntriesForScope(
  scope: BrowserHistoryScope,
  entries: BrowserHistoryEntry[],
): BrowserHistoryEntry[] {
  return entries.filter((entry) => browserHistoryMatchesScope(scope, entry));
}

export function browserHistoryScopeLabel(scope: BrowserHistoryScope): string {
  if (scope === "user") return "User";
  if (scope === "agent") return "Agent";
  return "all";
}

export function browserHistoryClearActionLabel(scope: BrowserHistoryScope): string {
  return `Clear ${browserHistoryScopeLabel(scope)} history`;
}

export function browserHistoryScopeCategory(scope: BrowserHistoryScope): string {
  if (scope === "user") return "Personal profile entries without a task";
  if (scope === "agent") return "Agent Work, disposable, and task-owned Personal entries";
  return "Personal, Agent Work, disposable, and task-owned Personal entries";
}

export function browserHistoryCountLabel(scope: BrowserHistoryScope, count: number): string {
  const entryLabel = count === 1 ? "entry" : "entries";
  if (scope === "all") return `${count} Browser history ${entryLabel}`;
  return `${count} ${browserHistoryScopeLabel(scope)} history ${entryLabel}`;
}
