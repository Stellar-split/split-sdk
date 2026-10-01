/**
 * SDK Performance & Concurrent Load Testing Suite
 *
 * Implements high-throughput request generation, concurrency control,
 * percentile latency metrics (p50, p95, p99), error rate accounting,
 * and throughput (TPS) measurement.
 */

export interface LoadTestConfig {
  /** Total number of simulated operations to execute */
  totalOperations: number;
  /** Maximum concurrent in-flight executions */
  concurrencyLimit: number;
  /** Optional timeout per operation in milliseconds */
  timeoutMs?: number;
  /** Ramp-up duration in ms before full load */
  rampUpMs?: number;
}

export interface LatencyPercentiles {
  min: number;
  max: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
}

export interface LoadTestResult {
  totalOperations: number;
  successfulOperations: number;
  failedOperations: number;
  errorRate: number;
  totalDurationMs: number;
  throughputTps: number;
  latencies: LatencyPercentiles;
  errors: Map<string, number>;
}

export class LoadTester {
  private config: Required<LoadTestConfig>;

  constructor(config: LoadTestConfig) {
    this.config = {
      totalOperations: Math.max(1, config.totalOperations),
      concurrencyLimit: Math.max(1, config.concurrencyLimit),
      timeoutMs: config.timeoutMs ?? 10_000,
      rampUpMs: config.rampUpMs ?? 0,
    };
  }

  /**
   * Executes a load test workload with the configured concurrency limits.
   */
  async execute<T>(workload: (index: number) => Promise<T>): Promise<LoadTestResult> {
    const latencies: number[] = [];
    const errorMap = new Map<string, number>();
    let successfulOperations = 0;
    let failedOperations = 0;

    const startTime = Date.now();
    let currentOpIndex = 0;

    const worker = async () => {
      while (true) {
        const opIndex = currentOpIndex++;
        if (opIndex >= this.config.totalOperations) {
          break;
        }

        // Apply progressive ramp-up delay if specified
        if (this.config.rampUpMs > 0 && opIndex < this.config.concurrencyLimit) {
          const delay = (this.config.rampUpMs / this.config.concurrencyLimit) * opIndex;
          await new Promise((r) => setTimeout(r, delay));
        }

        const opStart = performance.now();
        try {
          const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('Operation timed out')), this.config.timeoutMs);
          });

          await Promise.race([workload(opIndex), timeoutPromise]);
          const duration = performance.now() - opStart;
          latencies.push(duration);
          successfulOperations++;
        } catch (err: unknown) {
          const duration = performance.now() - opStart;
          latencies.push(duration);
          failedOperations++;
          const errKey = err instanceof Error ? err.message : String(err);
          errorMap.set(errKey, (errorMap.get(errKey) ?? 0) + 1);
        }
      }
    };

    const workerCount = Math.min(this.config.concurrencyLimit, this.config.totalOperations);
    const workers = Array.from({ length: workerCount }, () => worker());
    await Promise.all(workers);

    const totalDurationMs = Date.now() - startTime;
    const throughputTps =
      totalDurationMs > 0 ? (this.config.totalOperations / totalDurationMs) * 1000 : 0;
    const errorRate =
      this.config.totalOperations > 0 ? failedOperations / this.config.totalOperations : 0;

    return {
      totalOperations: this.config.totalOperations,
      successfulOperations,
      failedOperations,
      errorRate,
      totalDurationMs,
      throughputTps,
      latencies: this.calculatePercentiles(latencies),
      errors: errorMap,
    };
  }

  private calculatePercentiles(latencies: number[]): LatencyPercentiles {
    if (latencies.length === 0) {
      return { min: 0, max: 0, mean: 0, p50: 0, p90: 0, p95: 0, p99: 0 };
    }

    const sorted = [...latencies].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, val) => acc + val, 0);

    const getP = (p: number) => {
      const idx = Math.min(Math.floor((p / 100) * sorted.length), sorted.length - 1);
      return sorted[idx];
    };

    return {
      min: sorted[0],
      max: sorted[sorted.length - 1],
      mean: sum / sorted.length,
      p50: getP(50),
      p90: getP(90),
      p95: getP(95),
      p99: getP(99),
    };
  }
}
