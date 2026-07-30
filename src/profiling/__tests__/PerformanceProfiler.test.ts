import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

interface MethodMetrics {
  callCount: number;
  totalMs: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

interface FlameGraphNode {
  name: string;
  value: number;
  children: FlameGraphNode[];
}

type FlameGraphJson = FlameGraphNode;

interface ProfiledCall {
  method: string;
  startMs: number;
  durationMs: number;
  args: any[];
}

class RingBuffer<T> {
  private buffer: T[] = [];
  private index = 0;
  private capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  push(item: T): void {
    this.buffer[this.index] = item;
    this.index = (this.index + 1) % this.capacity;
  }

  getAll(): T[] {
    return this.buffer.filter((item) => item !== undefined);
  }
}

class PerformanceProfiler {
  private ringBuffer: RingBuffer<ProfiledCall>;
  private droppedCount: number = 0;
  private proxiedClient: any = null;
  private originalClient: any = null;

  constructor(depth: number = 1000) {
    this.ringBuffer = new RingBuffer(depth);
  }

  attach(client: any): void {
    if (this.proxiedClient !== null) {
      return;
    }

    this.originalClient = client;

    const handler = {
      get: (target: any, prop: string) => {
        if (typeof target[prop] === "function") {
          return async (...args: any[]) => {
            const startMs = performance.now();
            try {
              const result = await target[prop](...args);
              const durationMs = performance.now() - startMs;
              this.recordCall(prop, startMs, durationMs, args);
              return result;
            } catch (error) {
              const durationMs = performance.now() - startMs;
              this.recordCall(prop, startMs, durationMs, args);
              throw error;
            }
          };
        }
        return target[prop];
      },
    };

    this.proxiedClient = new Proxy(client, handler);
  }

  private recordCall(
    method: string,
    startMs: number,
    durationMs: number,
    args: any[]
  ): void {
    const call: ProfiledCall = {
      method,
      startMs,
      durationMs,
      args: this.summarizeArgs(args),
    };

    this.ringBuffer.push(call);
  }

  private summarizeArgs(args: any[]): any[] {
    return args.map((arg) => {
      if (typeof arg === "string") {
        return arg.length > 50 ? arg.substring(0, 50) + "..." : arg;
      }
      if (typeof arg === "object" && arg !== null) {
        return { type: "object", keys: Object.keys(arg) };
      }
      return arg;
    });
  }

  export(): FlameGraphJson {
    const calls = this.ringBuffer.getAll();
    const root: FlameGraphNode = {
      name: "root",
      value: 0,
      children: [],
    };

    const methodMap = new Map<string, FlameGraphNode>();

    for (const call of calls) {
      let methodNode = methodMap.get(call.method);
      if (!methodNode) {
        methodNode = {
          name: call.method,
          value: 0,
          children: [],
        };
        methodMap.set(call.method, methodNode);
        root.children.push(methodNode);
      }

      methodNode.value += call.durationMs;

      const callNode: FlameGraphNode = {
        name: `${call.method}(${call.durationMs.toFixed(2)}ms)`,
        value: call.durationMs,
        children: [],
      };
      methodNode.children.push(callNode);
    }

    root.value = root.children.reduce((sum, child) => sum + child.value, 0);

    return root;
  }

  summary(): Map<string, MethodMetrics> {
    const calls = this.ringBuffer.getAll();
    const methodStats = new Map<
      string,
      { durations: number[]; callCount: number }
    >();

    for (const call of calls) {
      if (!methodStats.has(call.method)) {
        methodStats.set(call.method, { durations: [], callCount: 0 });
      }

      const stats = methodStats.get(call.method)!;
      stats.durations.push(call.durationMs);
      stats.callCount++;
    }

    const result = new Map<string, MethodMetrics>();

    for (const [method, stats] of methodStats) {
      const durations = stats.durations.sort((a, b) => a - b);
      const totalMs = durations.reduce((sum, d) => sum + d, 0);
      const avgMs = totalMs / stats.callCount;

      const p50Index = Math.floor(durations.length * 0.5);
      const p95Index = Math.floor(durations.length * 0.95);
      const p99Index = Math.floor(durations.length * 0.99);

      result.set(method, {
        callCount: stats.callCount,
        totalMs,
        avgMs,
        p50Ms: durations[p50Index] || 0,
        p95Ms: durations[p95Index] || 0,
        p99Ms: durations[p99Index] || 0,
      });
    }

    return result;
  }

  detach(): void {
    this.proxiedClient = null;
  }

  getDroppedCount(): number {
    return this.droppedCount;
  }
}

describe("PerformanceProfiler", () => {
  let profiler: PerformanceProfiler;
  let mockClient: any;

  beforeEach(() => {
    profiler = new PerformanceProfiler(1000);
    mockClient = {
      methodA: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return "resultA";
      }),
      methodB: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return "resultB";
      }),
      methodC: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return "resultC";
      }),
    };
  });

  it("attaches to a client and intercepts method calls", async () => {
    profiler.attach(mockClient);

    const result = await mockClient.methodA();

    expect(result).toBe("resultA");
    expect(mockClient.methodA).toHaveBeenCalled();
  });

  it("records method call metrics correctly", async () => {
    profiler.attach(mockClient);

    await mockClient.methodA();
    await mockClient.methodA();
    await mockClient.methodB();

    const summary = profiler.summary();

    expect(summary.has("methodA")).toBe(true);
    expect(summary.has("methodB")).toBe(true);
    expect(summary.get("methodA")!.callCount).toBe(2);
    expect(summary.get("methodB")!.callCount).toBe(1);
  });

  it("computes correct total and average times", async () => {
    profiler.attach(mockClient);

    await mockClient.methodA();
    await mockClient.methodA();

    const summary = profiler.summary();
    const methodAMetrics = summary.get("methodA")!;

    expect(methodAMetrics.totalMs).toBeGreaterThanOrEqual(20);
    expect(methodAMetrics.avgMs).toBeGreaterThanOrEqual(10);
  });

  it("computes percentile latencies", async () => {
    profiler.attach(mockClient);

    for (let i = 0; i < 100; i++) {
      await mockClient.methodA();
    }

    const summary = profiler.summary();
    const methodAMetrics = summary.get("methodA")!;

    expect(methodAMetrics.p50Ms).toBeGreaterThan(0);
    expect(methodAMetrics.p95Ms).toBeGreaterThanOrEqual(methodAMetrics.p50Ms);
    expect(methodAMetrics.p99Ms).toBeGreaterThanOrEqual(methodAMetrics.p95Ms);
  });

  it("exports flamegraph-compatible JSON", async () => {
    profiler.attach(mockClient);

    await mockClient.methodA();
    await mockClient.methodB();
    await mockClient.methodC();

    const flameGraph = profiler.export();

    expect(flameGraph.name).toBe("root");
    expect(flameGraph.children).toBeDefined();
    expect(flameGraph.children.length).toBeGreaterThan(0);
    expect(flameGraph.value).toBeGreaterThan(0);
  });

  it("includes all called methods in flamegraph", async () => {
    profiler.attach(mockClient);

    await mockClient.methodA();
    await mockClient.methodB();
    await mockClient.methodC();

    const flameGraph = profiler.export();
    const methodNames = flameGraph.children.map((child) => child.name);

    expect(methodNames).toContain("methodA");
    expect(methodNames).toContain("methodB");
    expect(methodNames).toContain("methodC");
  });

  it("detach stops profiling without losing buffered data", async () => {
    profiler.attach(mockClient);

    await mockClient.methodA();
    profiler.detach();

    const summary = profiler.summary();

    expect(summary.has("methodA")).toBe(true);
    expect(summary.get("methodA")!.callCount).toBe(1);
  });

  it("calls after detach are not recorded", async () => {
    profiler.attach(mockClient);

    await mockClient.methodA();
    profiler.detach();
    await mockClient.methodA();

    const summary = profiler.summary();

    expect(summary.get("methodA")!.callCount).toBe(1);
  });

  it("handles method calls with arguments", async () => {
    profiler.attach(mockClient);

    mockClient.methodA = vi.fn(async (arg1: string, arg2: number) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return `result-${arg1}-${arg2}`;
    });

    await mockClient.methodA("test", 42);

    const summary = profiler.summary();

    expect(summary.get("methodA")!.callCount).toBe(1);
  });

  it("supports multiple method calls across 3+ methods", async () => {
    profiler.attach(mockClient);

    for (let i = 0; i < 100; i++) {
      await mockClient.methodA();
      await mockClient.methodB();
      await mockClient.methodC();
    }

    const summary = profiler.summary();

    expect(summary.get("methodA")!.callCount).toBe(100);
    expect(summary.get("methodB")!.callCount).toBe(100);
    expect(summary.get("methodC")!.callCount).toBe(100);
  });

  it("tracks accumulated duration correctly", async () => {
    profiler.attach(mockClient);

    await mockClient.methodA();
    await mockClient.methodA();
    await mockClient.methodA();

    const summary = profiler.summary();
    const methodAMetrics = summary.get("methodA")!;

    expect(methodAMetrics.totalMs).toBeGreaterThanOrEqual(30);
  });

  it("flamegraph includes method-level aggregation", async () => {
    profiler.attach(mockClient);

    await mockClient.methodA();
    await mockClient.methodA();

    const flameGraph = profiler.export();
    const methodANode = flameGraph.children.find(
      (child) => child.name === "methodA"
    );

    expect(methodANode).toBeDefined();
    expect(methodANode!.value).toBeGreaterThanOrEqual(20);
    expect(methodANode!.children.length).toBe(2);
  });

  it("handles errors in profiled methods", async () => {
    profiler.attach(mockClient);

    mockClient.methodA = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error("Test error");
    });

    try {
      await mockClient.methodA();
    } catch {
      // expected
    }

    const summary = profiler.summary();

    expect(summary.get("methodA")!.callCount).toBe(1);
  });

  it("summarizes long string arguments", async () => {
    profiler.attach(mockClient);

    mockClient.methodA = vi.fn(async (longString: string) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return "result";
    });

    const longArg = "a".repeat(100);
    await mockClient.methodA(longArg);

    const summary = profiler.summary();

    expect(summary.get("methodA")!.callCount).toBe(1);
  });

  it("ring buffer respects depth limit", async () => {
    const smallProfiler = new PerformanceProfiler(5);
    smallProfiler.attach(mockClient);

    for (let i = 0; i < 10; i++) {
      await mockClient.methodA();
    }

    const summary = smallProfiler.summary();

    expect(summary.get("methodA")!.callCount).toBeLessThanOrEqual(5);

    smallProfiler.detach();
  });

  it("percentiles are ordered correctly", async () => {
    profiler.attach(mockClient);

    for (let i = 0; i < 100; i++) {
      await mockClient.methodA();
    }

    const summary = profiler.summary();
    const metrics = summary.get("methodA")!;

    expect(metrics.p50Ms).toBeLessThanOrEqual(metrics.p95Ms);
    expect(metrics.p95Ms).toBeLessThanOrEqual(metrics.p99Ms);
  });

  it("export produces tree structure", async () => {
    profiler.attach(mockClient);

    await mockClient.methodA();
    await mockClient.methodB();

    const flameGraph = profiler.export();

    expect(flameGraph.name).toBe("root");
    expect(Array.isArray(flameGraph.children)).toBe(true);

    for (const child of flameGraph.children) {
      expect(child.name).toBeDefined();
      expect(typeof child.value).toBe("number");
      expect(Array.isArray(child.children)).toBe(true);
    }
  });

  it("supports reattach after detach", async () => {
    profiler.attach(mockClient);
    await mockClient.methodA();
    profiler.detach();

    profiler.attach(mockClient);
    await mockClient.methodB();

    const summary = profiler.summary();

    expect(summary.get("methodA")!.callCount).toBe(1);
    expect(summary.has("methodB")).toBe(true);
  });
});
