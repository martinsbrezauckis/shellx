/** Owns the updater resource represented by an on-screen offer. */
export interface UpdateOfferResource {
  version: string;
  close(): Promise<void>;
}

export type UpdateOfferCheck<T> =
  | { kind: "available"; update: T }
  | { kind: "none" }
  | { kind: "stale" }
  | { kind: "error"; error: unknown };

export class UpdateOffer<T extends UpdateOfferResource> {
  private generation = 0;
  private current: T | null = null;
  private installing = false;
  private clearAfterInstall = false;

  get offered(): T | null { return this.current; }
  get isInstalling(): boolean { return this.installing; }

  async check(checker: () => Promise<T | null>): Promise<UpdateOfferCheck<T>> {
    if (this.installing) return { kind: "stale" };
    const generation = ++this.generation;
    try {
      const update = await checker();
      if (this.installing || generation !== this.generation) {
        if (update) void update.close().catch(() => undefined);
        return { kind: "stale" };
      }
      const previous = this.current;
      this.current = update;
      if (previous && previous !== update) void previous.close().catch(() => undefined);
      return update ? { kind: "available", update } : { kind: "none" };
    } catch (error) {
      return this.installing || generation !== this.generation
        ? { kind: "stale" }
        : { kind: "error", error };
    }
  }

  clear(): void {
    ++this.generation;
    if (this.installing) {
      this.clearAfterInstall = true;
      return;
    }
    const previous = this.current;
    this.current = null;
    if (previous) void previous.close().catch(() => undefined);
  }

  beginInstall(expected: T | null): T | null {
    if (this.installing || !expected || this.current !== expected) return null;
    ++this.generation;
    this.installing = true;
    return this.current;
  }

  finishInstall(): void {
    this.installing = false;
    if (this.clearAfterInstall) {
      this.clearAfterInstall = false;
      this.clear();
    }
  }

}

/** Do not start a native check if its lazy loader outlived the caller. */
export async function checkOfferAfterLoad<T extends UpdateOfferResource>(
  offer: UpdateOffer<T>,
  loadChecker: () => Promise<() => Promise<T | null>>,
  isActive: () => boolean,
): Promise<UpdateOfferCheck<T>> {
  const checker = await loadChecker();
  if (!isActive()) return { kind: "stale" };
  return offer.check(checker);
}
