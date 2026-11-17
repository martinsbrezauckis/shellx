export interface BrowserRefreshScope {
  bookmarks: boolean;
  requests: boolean;
  transfers: boolean;
  history: boolean;
  receipts: boolean;
  logs: boolean;
}

interface ScheduledRefresh {
  scope: BrowserRefreshScope;
  resolve: () => void;
  reject: (error: unknown) => void;
}

function mergeRefreshScopes(left: BrowserRefreshScope, right: BrowserRefreshScope): BrowserRefreshScope {
  return {
    bookmarks: left.bookmarks || right.bookmarks,
    requests: left.requests || right.requests,
    transfers: left.transfers || right.transfers,
    history: left.history || right.history,
    receipts: left.receipts || right.receipts,
    logs: left.logs || right.logs,
  };
}

/** Wait for every selected slice before allowing a later refresh batch to run. */
export async function waitForBrowserRefreshSlices(slices: readonly Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(slices);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

/**
 * Serializes Browser state reads and coalesces waiting work by slice. An
 * older response therefore finishes before, rather than after, a newer state
 * read, while a later narrow event cannot discard a waiting broad refresh.
 */
export function createBrowserRefreshScheduler(
  run: (scope: BrowserRefreshScope) => Promise<void>,
): { refresh: (scope: BrowserRefreshScope) => Promise<void> } {
  let running = false;
  let pending: ScheduledRefresh[] = [];

  const drain = async (): Promise<void> => {
    while (pending.length > 0) {
      const work = pending;
      pending = [];
      const scope = work.reduce((merged, entry) => mergeRefreshScopes(merged, entry.scope), work[0]!.scope);
      try {
        await run(scope);
        for (const entry of work) entry.resolve();
      } catch (error) {
        for (const entry of work) entry.reject(error);
      }
    }
    running = false;
  };

  return {
    refresh: (scope) => new Promise<void>((resolve, reject) => {
      pending.push({ scope, resolve, reject });
      if (running) return;
      running = true;
      void drain();
    }),
  };
}
