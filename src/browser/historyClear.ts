import { clearBrowserHistoryCommand } from "./api";
import {
  browserHistoryCountLabel,
  browserHistoryEntriesForScope,
  browserHistoryScopeLabel,
  type BrowserHistoryScope,
} from "./historyScope";
import type { BrowserHistoryEntry } from "./types";

export interface BrowserHistoryClearStatus {
  tone: "success" | "error";
  message: string;
}

interface ClearScopedBrowserHistoryOptions {
  scope: BrowserHistoryScope;
  historyEntries: BrowserHistoryEntry[];
  busy: boolean;
  refresh: () => Promise<unknown>;
  setBusy: (busy: boolean) => void;
  setError: (message: string | null) => void;
  setStatus: (status: BrowserHistoryClearStatus | null) => void;
}

export async function clearScopedBrowserHistory({
  scope,
  historyEntries,
  busy,
  refresh,
  setBusy,
  setError,
  setStatus,
}: ClearScopedBrowserHistoryOptions): Promise<boolean> {
  const requestedCount = browserHistoryEntriesForScope(scope, historyEntries).length;
  if (requestedCount === 0 || busy) return false;
  setBusy(true);
  setError(null);
  setStatus(null);
  try {
    const receipt = await clearBrowserHistoryCommand(scope);
    const receiptScope = receipt.evidence?.scope;
    const removed = receipt.evidence?.removed;
    if (receipt.kind !== "browserHistoryCleared" || receiptScope !== scope
      || typeof removed !== "number" || !Number.isSafeInteger(removed) || removed < 0) {
      throw new Error("ShellX Browser returned an invalid history-clear receipt.");
    }
    await refresh();
    setStatus({ tone: "success", message: `Cleared ${browserHistoryCountLabel(scope, removed)}.` });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setError(message);
    setStatus({ tone: "error", message: `${browserHistoryScopeLabel(scope)} history was not cleared: ${message}` });
    return false;
  } finally {
    setBusy(false);
  }
}
