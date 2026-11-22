import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry } from '../src/retry';
import { executeWithRetry, isRetryable, RpcError } from '../src/retryPolicy';

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('retry triggers', () => {
    it('retries a retryable error and eventually resolves', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('network timeout'))
        .mockResolvedValueOnce('ok');

      const promise = withRetry(fn, { maxAttempts: 3, baseDelayMs: 100 });

      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('does not retry a non-retryable error', async () => {
      class ValidationError extends Error {
        constructor(message: string) {
          super(message);
          this.name = 'ValidationError';
        }
      }

      const error = new ValidationError('invalid input');
      const fn = vi.fn().mockRejectedValue(error);

      const promise = withRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 100,
        retryIf: (err) => !(err instanceof ValidationError),
      });

      await vi.runAllTimersAsync();

      await expect(promise).rejects.toBe(error);
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('backoff strategy', () => {
    it('follows exponential backoff baseDelayMs * 2^(attempt-1)', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('network timeout'))
        .mockRejectedValueOnce(new Error('network timeout'))
        .mockRejectedValueOnce(new Error('network timeout'))
        .mockResolvedValueOnce('ok');

      const baseDelayMs = 100;
      const promise = withRetry(fn, { maxAttempts: 4, baseDelayMs });

      // First attempt fails immediately, then waits baseDelayMs * 2^0 = 100
      await vi.advanceTimersByTimeAsync(0);
      expect(fn).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(99);
      expect(fn).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(fn).toHaveBeenCalledTimes(2);

      // Second retry waits baseDelayMs * 2^1 = 200
      await vi.advanceTimersByTimeAsync(199);
      expect(fn).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1);
      expect(fn).toHaveBeenCalledTimes(3);

      // Third retry waits baseDelayMs * 2^2 = 400
      await vi.advanceTimersByTimeAsync(399);
      expect(fn).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(1);
      expect(fn).toHaveBeenCalledTimes(4);

      await vi.runAllTimersAsync();
      const result = await promise;
      expect(result).toBe('ok');
    });
  });

  describe('max retries', () => {
    it('calls exactly maxAttempts times then rejects with last error', async () => {
      const errors = [
        new Error('network timeout 1'),
        new Error('network timeout 2'),
        new Error('network timeout 3'),
      ];
      const fn = vi
        .fn()
        .mockRejectedValueOnce(errors[0])
        .mockRejectedValueOnce(errors[1])
        .mockRejectedValueOnce(errors[2]);

      const promise = withRetry(fn, { maxAttempts: 3, baseDelayMs: 50 });

      await vi.runAllTimersAsync();

      await expect(promise).rejects.toBe(errors[2]);
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });

  describe('recovery', () => {
    it('succeeds after N transient failures and returns correct value', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('network timeout'))
        .mockRejectedValueOnce(new Error('network timeout'))
        .mockResolvedValueOnce(42);

      const promise = withRetry(fn, { maxAttempts: 5, baseDelayMs: 10 });

      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe(42);
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });

  describe('state management', () => {
    it('does not leak state between calls', async () => {
      const fn1 = vi
        .fn()
        .mockRejectedValueOnce(new Error('network timeout'))
        .mockResolvedValueOnce('first');

      const fn2 = vi.fn().mockResolvedValueOnce('second');

      const p1 = withRetry(fn1, { maxAttempts: 3, baseDelayMs: 10 });
      const p2 = withRetry(fn2, { maxAttempts: 3, baseDelayMs: 10 });

      await vi.runAllTimersAsync();

      await expect(p1).resolves.toBe('first');
      await expect(p2).resolves.toBe('second');

      expect(fn1).toHaveBeenCalledTimes(2);
      expect(fn2).toHaveBeenCalledTimes(1);
    });

    it('invocation count matches expectations across sequential calls', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('network timeout'))
        .mockResolvedValueOnce('a')
        .mockRejectedValueOnce(new Error('network timeout'))
        .mockRejectedValueOnce(new Error('network timeout'))
        .mockResolvedValueOnce('b');

      const p1 = withRetry(fn, { maxAttempts: 3, baseDelayMs: 10 });
      await vi.runAllTimersAsync();
      await expect(p1).resolves.toBe('a');
      expect(fn).toHaveBeenCalledTimes(2);

      const p2 = withRetry(fn, { maxAttempts: 3, baseDelayMs: 10 });
      await vi.runAllTimersAsync();
      await expect(p2).resolves.toBe('b');
      expect(fn).toHaveBeenCalledTimes(5);
    });
  });
});

describe('executeWithRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('isRetryable classification', () => {
    it('treats 429, 502, 503, 504 as retryable', () => {
      expect(isRetryable(new RpcError('rate limited', 429))).toBe(true);
      expect(isRetryable(new RpcError('bad gateway', 502))).toBe(true);
      expect(isRetryable(new RpcError('unavailable', 503))).toBe(true);
      expect(isRetryable(new RpcError('gateway timeout', 504))).toBe(true);
    });

    it('treats 400 as not retryable', () => {
      expect(isRetryable(new RpcError('bad request', 400))).toBe(false);
    });
  });

  describe('maxAttempts', () => {
    it('honors maxAttempts and rejects with last error', async () => {
      const errors = [
        new RpcError('unavailable 1', 503),
        new RpcError('unavailable 2', 503),
        new RpcError('unavailable 3', 503),
      ];
      const fn = vi
        .fn()
        .mockRejectedValueOnce(errors[0])
        .mockRejectedValueOnce(errors[1])
        .mockRejectedValueOnce(errors[2]);

      const promise = executeWithRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 50,
      });

      await vi.runAllTimersAsync();

      await expect(promise).rejects.toBe(errors[2]);
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });

  describe('maxDelayMs cap', () => {
    it('caps the delay at maxDelayMs', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new RpcError('unavailable', 503))
        .mockRejectedValueOnce(new RpcError('unavailable', 503))
        .mockRejectedValueOnce(new RpcError('unavailable', 503))
        .mockResolvedValueOnce('ok');

      const onRetry = vi.fn();
      const promise = executeWithRetry(fn, {
        maxAttempts: 4,
        baseDelayMs: 1000,
        maxDelayMs: 1500,
        onRetry,
      });

      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(4);

      // Delays: attempt 1 -> 1000, attempt 2 -> min(2000, 1500) = 1500,
      // attempt 3 -> min(4000, 1500) = 1500
      expect(onRetry).toHaveBeenCalledTimes(3);
      expect(onRetry.mock.calls[0][2]).toBe(1000);
      expect(onRetry.mock.calls[1][2]).toBe(1500);
      expect(onRetry.mock.calls[2][2]).toBe(1500);
    });
  });

  describe('onRetry callback', () => {
    it('is invoked with correct attempt, error, and delay', async () => {
      const err1 = new RpcError('unavailable 1', 503);
      const err2 = new RpcError('unavailable 2', 503);
      const fn = vi
        .fn()
        .mockRejectedValueOnce(err1)
        .mockRejectedValueOnce(err2)
        .mockResolvedValueOnce('ok');

      const onRetry = vi.fn();
      const promise = executeWithRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 100,
        onRetry,
      });

      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe('ok');
      expect(onRetry).toHaveBeenCalledTimes(2);

      expect(onRetry.mock.calls[0][0]).toBe(1);
      expect(onRetry.mock.calls[0][1]).toBe(err1);
      expect(onRetry.mock.calls[0][2]).toBe(100);

      expect(onRetry.mock.calls[1][0]).toBe(2);
      expect(onRetry.mock.calls[1][1]).toBe(err2);
      expect(onRetry.mock.calls[1][2]).toBe(200);
    });
  });

  describe('retryIf override', () => {
    it('respects a custom retryIf predicate', async () => {
      const error = new RpcError('bad request', 400);
      const fn = vi.fn().mockRejectedValue(error);

      const promise = executeWithRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 50,
        retryIf: () => true,
      });

      await vi.runAllTimersAsync();

      await expect(promise).rejects.toBe(error);
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('does not retry when retryIf returns false', async () => {
      const error = new RpcError('unavailable', 503);
      const fn = vi.fn().mockRejectedValue(error);

      const promise = executeWithRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 50,
        retryIf: () => false,
      });

      await vi.runAllTimersAsync();

      await expect(promise).rejects.toBe(error);
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });
});