/**
 * Fixed-capacity circular (ring) buffer.
 *
 * Used by {@link FeeTrendAnalyzer} (../fees/trend.js) to hold a rolling
 * window of samples, evicting the oldest entry once capacity is reached.
 */

export class CircularBuffer<T> {
  private readonly items: Array<T | undefined>;
  private readonly capacity: number;
  private start = 0;
  private count = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`CircularBuffer capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
    this.items = new Array<T | undefined>(capacity);
  }

  /**
   * Appends an item, evicting the oldest entry first when the buffer is
   * already at capacity.
   */
  push(item: T): void {
    const index = (this.start + this.count) % this.capacity;
    this.items[index] = item;

    if (this.count < this.capacity) {
      this.count += 1;
    } else {
      this.start = (this.start + 1) % this.capacity;
    }
  }

  /**
   * Evicts entries from the oldest end while `predicate` holds, stopping
   * at the first entry that doesn't match. Suitable for TTL eviction,
   * since samples are always pushed in increasing recency order.
   *
   * @returns The evicted items, oldest first.
   */
  evictOldestWhile(predicate: (item: T) => boolean): T[] {
    const evicted: T[] = [];
    while (this.count > 0 && predicate(this.items[this.start] as T)) {
      evicted.push(this.items[this.start] as T);
      this.items[this.start] = undefined;
      this.start = (this.start + 1) % this.capacity;
      this.count -= 1;
    }
    return evicted;
  }

  /** Returns all currently held items, oldest first. */
  toArray(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this.count; i += 1) {
      result.push(this.items[(this.start + i) % this.capacity] as T);
    }
    return result;
  }

  /** Number of items currently held. */
  get size(): number {
    return this.count;
  }

  /** Maximum number of items this buffer can hold. */
  get maxSize(): number {
    return this.capacity;
  }

  /** Whether the buffer is holding as many items as its capacity allows. */
  get isFull(): boolean {
    return this.count === this.capacity;
  }

  /** Removes all items. */
  clear(): void {
    this.items.fill(undefined);
    this.start = 0;
    this.count = 0;
  }
}
