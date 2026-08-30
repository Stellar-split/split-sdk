/**
 * LazyInitializer — single-promise initialization gate with configurable retry.
 *
 * Stores a factory function and a nullable Promise state. The first call to
 * .get() invokes the factory and caches the resulting Promise. All subsequent
 * concurrent and later calls await the same Promise, ensuring the factory is
 * called exactly once per successful initialization.
 *
 * On failure the cached Promise is cleared so that the next .get() call
 * re-attempts initialization.
 *
 * Issue #479
 */

import { pbkdf2 } from "node:crypto";

// ---------------------------------------------------------------------------
// LazyInitializer<T>
// ---------------------------------------------------------------------------

/**
 * Options for {@link LazyInitializer}.
 */
export interface LazyInitializerOptions {
  /**
   * Maximum number of retry attempts after a failed initialization.
   * @default 3
   */
  maxRetries?: number;
  /**
   * Delay between retry attempts in milliseconds.
   * @default 1000
   */
  retryDelayMs?: number;
}

/**
 * Generic lazy initializer with single-flight coalescing and failure reset.
 *
 * @template T  The type of the initialized resource.
 *
 * @example
 * ```typescript
 * const lazy = new LazyInitializer(() => connectToDatabase());
 *
 * // First call starts the factory; concurrent callers share the same promise.
 * const db = await lazy.get();
 *
 * // After the promise resolves, isReady() returns true.
 * lazy.isReady(); // → true
 *
 * // On failure the promise is cleared so the next get() retries.
 * ```
 */
export class LazyInitializer<T> {
  private readonly factory: () => Promise<T>;
  private _promise: Promise<T> | null = null;
  private _resolved = false;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(factory: () => Promise<T>, options?: LazyInitializerOptions) {
    this.factory = factory;
    this.maxRetries = options?.maxRetries ?? 3;
    this.retryDelayMs = options?.retryDelayMs ?? 1_000;
  }

  /**
   * Returns the initialized resource.
   *
   * - If already initialized, resolves immediately with the cached value.
   * - If initialization is in progress (from a concurrent call), awaits the
   *   same Promise without calling the factory again.
   * - If not yet started, calls the factory and caches the resulting Promise.
   * - If the previous attempt failed, clears the cached Promise and retries.
   * - Retries up to maxRetries times with retryDelayMs between attempts.
   */
  get(): Promise<T> {
    if (!this._promise) {
      this._promise = this._attempt(0);
    }
    return this._promise;
  }

  private async _attempt(attempt: number): Promise<T> {
    try {
      const value = await this.factory();
      this._resolved = true;
      return value;
    } catch (err) {
      if (attempt < this.maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
        return this._attempt(attempt + 1);
      }
      this._promise = null;
      this._resolved = false;
      throw err;
    }
  }

  /**
   * Returns true synchronously when the factory has completed successfully.
   * Returns false when initialization is pending or hasn't started.
   */
  isReady(): boolean {
    return this._resolved;
  }

  /**
   * Resets the initializer back to its un-initialized state.
   * Useful for testing or forced re-connection scenarios.
   */
  reset(): void {
    this._promise = null;
    this._resolved = false;
  }
}
