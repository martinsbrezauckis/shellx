export type RendererEventBatchScheduler = (flush: () => void) => number;
export type RendererEventBatchCanceller = (handle: number) => void;

/**
 * Coalesce a high-rate native event stream into bounded renderer commits.
 * Event order is preserved, threshold flushes keep hidden-window queues
 * bounded, and disposal never schedules a state update after unmount.
 */
export class RendererEventBatcher<T> {
  private readonly pending: T[] = [];
  private scheduledHandle: number | null = null;
  private disposed = false;

  constructor(
    private readonly onFlush: (batch: readonly T[]) => void,
    private readonly schedule: RendererEventBatchScheduler,
    private readonly cancel: RendererEventBatchCanceller,
    private readonly maxBatchSize = 128,
  ) {
    if (!Number.isSafeInteger(maxBatchSize) || maxBatchSize < 1) {
      throw new Error("renderer event batch size must be a positive safe integer");
    }
  }

  enqueue(value: T): void {
    if (this.disposed) return;
    this.pending.push(value);
    if (this.pending.length >= this.maxBatchSize) {
      this.flush();
      return;
    }
    if (this.scheduledHandle === null) {
      this.scheduledHandle = this.schedule(() => this.flush());
    }
  }

  flush(): void {
    if (this.disposed || this.pending.length === 0) return;
    if (this.scheduledHandle !== null) {
      this.cancel(this.scheduledHandle);
      this.scheduledHandle = null;
    }
    const batch = this.pending.splice(0, this.pending.length);
    this.onFlush(batch);
  }

  pendingCount(): number {
    return this.pending.length;
  }

  dispose(): void {
    this.disposed = true;
    this.pending.length = 0;
    if (this.scheduledHandle !== null) {
      this.cancel(this.scheduledHandle);
      this.scheduledHandle = null;
    }
  }
}
