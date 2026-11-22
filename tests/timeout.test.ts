import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withTimeout, withTimeoutOrThrow, RequestTimeoutError } from '../src/timeout';
import { MaxRetriesExceededError } from '../src/requestRetry';

describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('triggers timeout when the function never resolves', async () => {
    const timeoutMs = 1000;
    let receivedSignal: AbortSignal | undefined;

    const neverResolves = vi.fn(
      (signal: AbortSignal) =>
        new Promise<never>(() => {
          receivedSignal = signal;
        })
    );

    const resultPromise = withTimeout(neverResolves, timeoutMs, 'GET');

    await vi.advanceTimersByTimeAsync(timeoutMs);

    const result = await resultPromise;

    expect(result).toEqual({ ok: false, reason: 'timeout' });
    expect(neverResolves).toHaveBeenCalledTimes(1);
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal!.aborted).toBe(true);
  });

  it('does not trigger timeout when the function resolves in time', async () => {
    const timeoutMs = 1000;

    const fastFn = vi.fn(
      (_signal: AbortSignal) =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve('done'), 100);
        })
    );

    const resultPromise = withTimeout(fastFn, timeoutMs, 'GET');

    await vi.advanceTimersByTimeAsync(100);

    const result = await resultPromise;

    expect(result).toEqual({ ok: true, value: 'done' });
  });

  it('clears the internal timeout timer on success', async () => {
    const timeoutMs = 1000;

    const fastFn = vi.fn(
      (_signal: AbortSignal) =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve('done'), 100);
        })
    );

    const resultPromise = withTimeout(fastFn, timeoutMs, 'GET');

    await vi.advanceTimersByTimeAsync(100);
    await resultPromise;

    // The internal timeout timer should have been cleared; no pending timers remain.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases resources and allows subsequent calls after a timeout', async () => {
    const timeoutMs = 500;

    const neverResolves = vi.fn(
      (_signal: AbortSignal) => new Promise<never>(() => {})
    );

    const firstResult = withTimeout(neverResolves, timeoutMs, 'GET');
    await vi.advanceTimersByTimeAsync(timeoutMs);
    expect(await firstResult).toEqual({ ok: false, reason: 'timeout' });

    // No leaked timers after the timeout fired.
    expect(vi.getTimerCount()).toBe(0);

    // A subsequent call should work fine.
    const fastFn = vi.fn(
      (_signal: AbortSignal) =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve('recovered'), 50);
        })
    );

    const secondResult = withTimeout(fastFn, timeoutMs, 'POST');
    await vi.advanceTimersByTimeAsync(50);

    expect(await secondResult).toEqual({ ok: true, value: 'recovered' });
    expect(fastFn).toHaveBeenCalledTimes(1);
  });

  it('recovers after a timeout with a fast function', async () => {
    const timeoutMs = 300;

    const neverResolves = vi.fn(
      (_signal: AbortSignal) => new Promise<never>(() => {})
    );

    const firstResult = withTimeout(neverResolves, timeoutMs, 'GET');
    await vi.advanceTimersByTimeAsync(timeoutMs);
    expect(await firstResult).toEqual({ ok: false, reason: 'timeout' });

    const fastFn = vi.fn(
      (_signal: AbortSignal) =>
        new Promise<number>((resolve) => {
          setTimeout(() => resolve(42), 10);
        })
    );

    const secondResult = withTimeout(fastFn, timeoutMs, 'GET');
    await vi.advanceTimersByTimeAsync(10);

    expect(await secondResult).toEqual({ ok: true, value: 42 });
  });
});

describe('withTimeoutOrThrow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('throws RequestTimeoutError on timeout', async () => {
    const timeoutMs = 750;

    const neverResolves = vi.fn(
      (_signal: AbortSignal) => new Promise<never>(() => {})
    );

    const resultPromise = withTimeoutOrThrow(neverResolves, timeoutMs, 'PUT');

    // Prevent unhandled rejection warnings while advancing timers.
    const assertion = expect(resultPromise).rejects.toBeInstanceOf(
      RequestTimeoutError
    );

    await vi.advanceTimersByTimeAsync(timeoutMs);

    await assertion;
  });

  it('resolves normally when the function completes in time', async () => {
    const timeoutMs = 1000;

    const fastFn = vi.fn(
      (_signal: AbortSignal) =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve('ok'), 20);
        })
    );

    const resultPromise = withTimeoutOrThrow(fastFn, timeoutMs, 'GET');
    await vi.advanceTimersByTimeAsync(20);

    await expect(resultPromise).resolves.toBe('ok');
  });
});

describe('RequestTimeoutError', () => {
  it('has the correct name, code, and message including timeout and method', () => {
    const error = new RequestTimeoutError(1500, 'GET');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('RequestTimeoutError');
    expect(error.code).toBe('REQUEST_TIMEOUT');
    expect(error.message).toContain('1500');
    expect(error.message).toContain('GET');
  });

  it('produces a clear, human-readable message', () => {
    const error = new RequestTimeoutError(2000, 'POST');

    expect(error.message).toMatch(/timeout/i);
    expect(error.message).toContain('2000');
    expect(error.message).toContain('POST');
  });
});

describe('MaxRetriesExceededError', () => {
  it('has the correct name, code, and message', () => {
    const error = new MaxRetriesExceededError(3);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('MaxRetriesExceededError');
    expect(error.code).toBe('MAX_RETRIES_EXCEEDED');
    expect(error.message).toContain('3');
  });

  it('produces a clear, human-readable message', () => {
    const error = new MaxRetriesExceededError(5);

    expect(error.message).toMatch(/retr/i);
    expect(error.message).toContain('5');
  });
});