import { describe, it, expect } from 'vitest';
import { LoadTester } from '../src/perf/loadTester';

describe('LoadTester Performance & Concurrency Suite', () => {
  it('executes concurrent operations within target concurrency bounds', async () => {
    let activeConcurrency = 0;
    let peakConcurrency = 0;

    const tester = new LoadTester({
      totalOperations: 50,
      concurrencyLimit: 5,
      timeoutMs: 2000,
    });

    const result = await tester.execute(async (idx) => {
      activeConcurrency++;
      peakConcurrency = Math.max(peakConcurrency, activeConcurrency);
      await new Promise((r) => setTimeout(r, 10));
      activeConcurrency--;
      return { index: idx, status: 'ok' };
    });

    expect(result.totalOperations).toBe(50);
    expect(result.successfulOperations).toBe(50);
    expect(result.failedOperations).toBe(0);
    expect(result.errorRate).toBe(0);
    expect(peakConcurrency).toBeLessThanOrEqual(5);
    expect(result.throughputTps).toBeGreaterThan(0);
    expect(result.latencies.p50).toBeGreaterThan(0);
    expect(result.latencies.p95).toBeGreaterThanOrEqual(result.latencies.p50);
    expect(result.latencies.max).toBeGreaterThanOrEqual(result.latencies.min);
  });

  it('captures failures, calculates error rates, and isolates errors', async () => {
    const tester = new LoadTester({
      totalOperations: 20,
      concurrencyLimit: 4,
      timeoutMs: 1000,
    });

    const result = await tester.execute(async (idx) => {
      if (idx % 4 === 0) {
        throw new Error('Simulated network congestion');
      }
      return 'success';
    });

    expect(result.totalOperations).toBe(20);
    expect(result.failedOperations).toBe(5);
    expect(result.successfulOperations).toBe(15);
    expect(result.errorRate).toBe(0.25);
    expect(result.errors.get('Simulated network congestion')).toBe(5);
  });

  it('handles timeouts accurately when operations exceed budget', async () => {
    const tester = new LoadTester({
      totalOperations: 5,
      concurrencyLimit: 2,
      timeoutMs: 50,
    });

    const result = await tester.execute(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });

    expect(result.failedOperations).toBe(5);
    expect(result.errorRate).toBe(1);
    expect(result.errors.get('Operation timed out')).toBe(5);
  });
});
