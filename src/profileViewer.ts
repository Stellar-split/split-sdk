/**
 * Profiling tools for performance analysis (issue #1181).
 *
 * Provides CPU sampling, memory tracking, flame graph generation,
 * call tracing, profile export, and a lightweight profile viewer.
 */

export interface CpuSample {
  stack: string[];
  selfTimeMs: number;
  timestamp: number;
}

export interface MemorySample {
  usedHeapBytes: number;
  totalHeapBytes: number;
  timestamp: number;
}

export interface TraceSpan {
  name: string;
  startMs: number;
  endMs: number;
  children: TraceSpan[];
}

export interface FlameNode {
  name: string;
  value: number;
  children: FlameNode[];
}

export interface ProfileExport {
  cpu: CpuSample[];
  memory: MemorySample[];
  traces: TraceSpan[];
  flameGraph: FlameNode;
  exportedAt: number;
}

function now(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/**
 * CPU profiler: samples the currently executing stack at a fixed interval.
 */
export class CpuProfiler {
  private samples: CpuSample[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSampleAt = 0;
  private stackProvider: () => string[];

  constructor(stackProvider?: () => string[]) {
    this.stackProvider = stackProvider || (() => []);
  }

  start(intervalMs = 10): void {
    if (this.timer !== null) return;
    this.lastSampleAt = now();
    this.timer = setInterval(() => this.sample(), intervalMs);
  }

  stop(): CpuSample[] {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return this.getSamples();
  }

  sample(): void {
    const t = now();
    const selfTimeMs = this.lastSampleAt ? t - this.lastSampleAt : 0;
    this.lastSampleAt = t;
    this.samples.push({
      stack: this.stackProvider(),
      selfTimeMs,
      timestamp: t,
    });
  }

  getSamples(): CpuSample[] {
    return this.samples.slice();
  }

  reset(): void {
    this.samples = [];
    this.lastSampleAt = 0;
  }
}

/**
 * Memory profiler: records heap usage over time when available.
 */
export class MemoryProfiler {
  private samples: MemorySample[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  start(intervalMs = 100): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.sample(), intervalMs);
  }

  stop(): MemorySample[] {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return this.getSamples();
  }

  sample(): void {
    const mem = (typeof performance !== 'undefined' && (performance as any).memory) || null;
    if (!mem) return;
    this.samples.push({
      usedHeapBytes: mem.usedJSHeapSize || 0,
      totalHeapBytes: mem.totalJSHeapSize || 0,
      timestamp: now(),
    });
  }

  getSamples(): MemorySample[] {
    return this.samples.slice();
  }

  reset(): void {
    this.samples = [];
  }
}

/**
 * Call tracer: captures nested spans for call tracing.
 */
export class CallTracer {
  private roots: TraceSpan[] = [];
  private stack: TraceSpan[] = [];

  begin(name: string): TraceSpan {
    const span: TraceSpan = { name, startMs: now(), endMs: 0, children: [] };
    const parent = this.stack[this.stack.length - 1];
    if (parent) {
      parent.children.push(span);
    } else {
      this.roots.push(span);
    }
    this.stack.push(span);
    return span;
  }

  end(): void {
    const span = this.stack.pop();
    if (span) span.endMs = now();
  }

  trace<T>(name: string, fn: () => T): T {
    this.begin(name);
    try {
      return fn();
    } finally {
      this.end();
    }
  }

  getTraces(): TraceSpan[] {
    return this.roots.slice();
  }

  reset(): void {
    this.roots = [];
    this.stack = [];
  }
}

/**
 * Build a flame graph tree from CPU samples.
 */
export function buildFlameGraph(samples: CpuSample[]): FlameNode {
  const root: FlameNode = { name: 'root', value: 0, children: [] };
  for (const sample of samples) {
    root.value += sample.selfTimeMs;
    let node = root;
    for (const frame of sample.stack) {
      let child = node.children.find((c) => c.name === frame);
      if (!child) {
        child = { name: frame, value: 0, children: [] };
        node.children.push(child);
      }
      child.value += sample.selfTimeMs;
      node = child;
    }
  }
  return root;
}

/**
 * Export a complete profile snapshot.
 */
export function exportProfile(
  cpu: CpuSample[],
  memory: MemorySample[],
  traces: TraceSpan[],
): ProfileExport {
  return {
    cpu: cpu.slice(),
    memory: memory.slice(),
    traces: traces.slice(),
    flameGraph: buildFlameGraph(cpu),
    exportedAt: Date.now(),
  };
}

/**
 * Render a flame graph as indented text lines for a simple profile viewer.
 */
export function renderFlameGraph(node: FlameNode, depth = 0): string[] {
  const lines = [`${'  '.repeat(depth)}${node.name} (${node.value.toFixed(2)}ms)`];
  for (const child of node.children) {
    lines.push(...renderFlameGraph(child, depth + 1));
  }
  return lines;
}

/**
 * Render a profile export into a human-readable viewer string.
 */
export function renderProfileViewer(profile: ProfileExport): string {
  const lines: string[] = [];
  lines.push('=== CPU Flame Graph ===');
  lines.push(...renderFlameGraph(profile.flameGraph));
  lines.push('');
  lines.push('=== Memory ===');
  if (profile.memory.length === 0) {
    lines.push('(no memory samples)');
  } else {
    const last = profile.memory[profile.memory.length - 1]!;
    lines.push(`used: ${last.usedHeapBytes} bytes, total: ${last.totalHeapBytes} bytes`);
  }
  lines.push('');
  lines.push('=== Traces ===');
  const renderSpan = (span: TraceSpan, depth: number): void => {
    lines.push(`${'  '.repeat(depth)}${span.name} (${(span.endMs - span.startMs).toFixed(2)}ms)`);
    for (const child of span.children) renderSpan(child, depth + 1);
  };
  if (profile.traces.length === 0) {
    lines.push('(no traces)');
  } else {
    for (const span of profile.traces) renderSpan(span, 0);
  }
  return lines.join('\n');
}
