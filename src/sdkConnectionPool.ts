/** Issue #1296: Generic resource pool with sizing, management and stats. */

export interface SdkPoolOptions<T> {
  create: () => Promise<T>;
  destroy?: (item: T) => void | Promise<void>;
  min?: number;
  max?: number;
}

export interface SdkPoolStats {
  size: number;
  idle: number;
  active: number;
  waiting: number;
  created: number;
  reused: number;
}

export class SdkConnectionPool<T> {
  private idle: T[] = [];
  private active = new Set<T>();
  private waiters: Array<(item: T) => void> = [];
  private created = 0;
  private reused = 0;
  private creating = 0;
  private max: number;
  private min: number;

  constructor(private readonly opts: SdkPoolOptions<T>) {
    this.min = opts.min ?? 0;
    this.max = opts.max ?? 10;
  }

  async acquire(): Promise<T> {
    const item = this.idle.pop();
    if (item !== undefined) {
      this.reused++;
      this.active.add(item);
      return item;
    }
    if (this.active.size + this.idle.length + this.creating < this.max) {
      this.creating++;
      try {
        const c = await this.opts.create();
        this.created++;
        this.active.add(c);
        return c;
      } finally {
        this.creating--;
      }
    }
    return new Promise<T>((resolve) => this.waiters.push(resolve));
  }

  release(item: T): void {
    if (!this.active.delete(item)) return;
    const w = this.waiters.shift();
    if (w) {
      this.reused++;
      this.active.add(item);
      w(item);
    } else {
      this.idle.push(item);
    }
  }

  /** Resize; shrinking evicts idle items above the new max (keeping at least min). */
  async resize(min: number, max: number): Promise<void> {
    this.min = min;
    this.max = max;
    while (this.idle.length > 0 && this.active.size + this.idle.length > Math.max(max, min)) {
      await this.opts.destroy?.(this.idle.pop() as T);
    }
  }

  async drain(): Promise<void> {
    const items = this.idle.splice(0);
    for (const i of items) await this.opts.destroy?.(i);
  }

  stats(): SdkPoolStats {
    return {
      size: this.active.size + this.idle.length,
      idle: this.idle.length,
      active: this.active.size,
      waiting: this.waiters.length,
      created: this.created,
      reused: this.reused,
    };
  }
}
