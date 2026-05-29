export type RequestPriority = "high" | "normal" | "low";

const PRIORITY_VALUE: Record<RequestPriority, number> = {
  high: 0,
  normal: 1,
  low: 2,
};

interface HeapItem<T> {
  priority: RequestPriority;
  seq: number;
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export class PriorityQueue {
  private heap: HeapItem<unknown>[] = [];
  private seq = 0;
  private running = false;

  enqueue<T>(priority: RequestPriority, execute: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const item: HeapItem<T> = {
        priority,
        seq: this.seq++,
        execute,
        resolve,
        reject,
      };
      this._insert(item as HeapItem<unknown>);
      if (!this.running) void this._drain();
    });
  }

  private _compare(a: HeapItem<unknown>, b: HeapItem<unknown>): number {
    const pa = PRIORITY_VALUE[a.priority];
    const pb = PRIORITY_VALUE[b.priority];
    if (pa !== pb) return pa - pb;
    return a.seq - b.seq;
  }

  private _insert(item: HeapItem<unknown>): void {
    this.heap.push(item);
    let i = this.heap.length - 1;
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (this._compare(this.heap[i]!, this.heap[parent]!) < 0) {
        [this.heap[i], this.heap[parent]] = [this.heap[parent]!, this.heap[i]!];
        i = parent;
      } else {
        break;
      }
    }
  }

  private _extractMin(): HeapItem<unknown> | undefined {
    if (this.heap.length === 0) return undefined;
    const min = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this._siftDown(0);
    }
    return min;
  }

  private _siftDown(i: number): void {
    const n = this.heap.length;
    while (true) {
      let smallest = i;
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      if (l < n && this._compare(this.heap[l]!, this.heap[smallest]!) < 0) smallest = l;
      if (r < n && this._compare(this.heap[r]!, this.heap[smallest]!) < 0) smallest = r;
      if (smallest === i) break;
      [this.heap[i], this.heap[smallest]] = [this.heap[smallest]!, this.heap[i]!];
      i = smallest;
    }
  }

  private async _drain(): Promise<void> {
    this.running = true;
    while (this.heap.length > 0) {
      const item = this._extractMin()!;
      try {
        const result = await item.execute();
        item.resolve(result);
      } catch (e) {
        item.reject(e);
      }
    }
    this.running = false;
  }
}
