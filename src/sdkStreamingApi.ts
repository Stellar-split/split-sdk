/** Issue #1298: SDK streaming API with chunk handling, backpressure and tracking. */

export interface SdkStreamStats {
  id: string;
  chunksReceived: number;
  chunksDelivered: number;
  pending: number;
  paused: boolean;
  closed: boolean;
}

export interface SdkStreamOptions {
  highWaterMark?: number;
  onChunk?: (chunk: unknown) => void;
}

export class SdkStream<T> {
  private buffer: T[] = [];
  private received = 0;
  private delivered = 0;
  private closed = false;
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private drainWaiters: Array<() => void> = [];
  private readonly hwm: number;

  constructor(readonly id: string, private readonly opts: SdkStreamOptions = {}) {
    this.hwm = opts.highWaterMark ?? 16;
  }

  /** Returns false when the buffer is full (caller should await drain()). */
  push(chunk: T): boolean {
    if (this.closed) throw new Error("Stream closed");
    this.received++;
    this.opts.onChunk?.(chunk);
    const waiter = this.waiters.shift();
    if (waiter) {
      this.delivered++;
      waiter({ value: chunk, done: false });
    } else {
      this.buffer.push(chunk);
    }
    return this.buffer.length < this.hwm;
  }

  drain(): Promise<void> {
    if (this.buffer.length < this.hwm) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }

  private next(): Promise<IteratorResult<T>> {
    if (this.buffer.length > 0) {
      const value = this.buffer.shift() as T;
      this.delivered++;
      if (this.buffer.length < this.hwm) this.drainWaiters.splice(0).forEach((r) => r());
      return Promise.resolve({ value, done: false });
    }
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }

  stats(): SdkStreamStats {
    return {
      id: this.id,
      chunksReceived: this.received,
      chunksDelivered: this.delivered,
      pending: this.buffer.length,
      paused: this.buffer.length >= this.hwm,
      closed: this.closed,
    };
  }
}

export class SdkStreamRegistry {
  private streams = new Map<string, SdkStream<any>>();
  private seq = 0;

  create<T>(opts?: SdkStreamOptions): SdkStream<T> {
    const s = new SdkStream<T>(`stream-${++this.seq}`, opts);
    this.streams.set(s.id, s);
    return s;
  }

  get(id: string): SdkStream<any> | undefined {
    return this.streams.get(id);
  }

  /** Close and forget a stream. */
  remove(id: string): void {
    this.streams.get(id)?.close();
    this.streams.delete(id);
  }

  stats(): SdkStreamStats[] {
    return [...this.streams.values()].map((s) => s.stats());
  }
}
