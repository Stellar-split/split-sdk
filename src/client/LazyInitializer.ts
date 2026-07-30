/**
 * LazyInitializer — single-promise initialization gate.
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

// ---------------------------------------------------------------------------
// LazyInitializer<T>
// ---------------------------------------------------------------------------

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

  constructor(factory: () => Promise<T>) {
    this.factory = factory;
  }

  /**
   * Returns the initialized resource.
   *
   * - If already initialized, resolves immediately with the cached value.
   * - If initialization is in progress (from a concurrent call), awaits the
   *   same Promise without calling the factory again.
   * - If not yet started, calls the factory and caches the resulting Promise.
   * - If the previous attempt failed, clears the cached Promise and retries.
   */
  get(): Promise<T> {
    if (!this._promise) {
      this._promise = this.factory().then(
        (value) => {
          this._resolved = true;
          return value;
        },
        (err: unknown) => {
          // Reset so the next call retries initialization.
          this._promise = null;
          this._resolved = false;
          throw err;
        },
      );
    }
    return this._promise;
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
