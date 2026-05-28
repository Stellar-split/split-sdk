export class Deduplicator<T> {
  private _inflight = new Map<string, Promise<T>>();
  private _hits = 0;
  private _misses = 0;

  dedupe(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this._inflight.get(key);
    if (existing) {
      this._hits++;
      return existing;
    }
    this._misses++;
    const promise = fn().finally(() => this._inflight.delete(key));
    this._inflight.set(key, promise);
    return promise;
  }

  get cacheHitRate(): number {
    const total = this._hits + this._misses;
    return total === 0 ? 0 : this._hits / total;
  }
}
