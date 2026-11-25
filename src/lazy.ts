/**
 * Lazy evaluation system (#1326).
 *
 * Provides deferred, memoized computation via thunk-based lazy values.
 * A `Lazy<T>` wraps a computation that is not executed until `force()` is
 * called; the result is cached so subsequent forces are free. Lazy values
 * compose through `map`/`chain`/`flatMap` without forcing intermediate
 * computations until the final value is forced.
 */

export type LazyState = 'pending' | 'evaluating' | 'evaluated' | 'failed';

export interface LazyStats {
  /** Number of times the underlying computation actually ran. */
  evaluations: number;
  /** Number of times `force()` was called. */
  forces: number;
  /** Number of forces served from the memoized cache. */
  cacheHits: number;
  /** Current lifecycle state. */
  state: LazyState;
}

const LAZY_BRAND = Symbol('stellarSplit.lazy');

export class Lazy<T> {
  readonly [LAZY_BRAND] = true;

  private thunk: (() => T) | null;
  private cached: T | undefined;
  private error: unknown;
  private state: LazyState = 'pending';
  private evaluations = 0;
  private forces = 0;
  private cacheHits = 0;

  constructor(thunk: () => T) {
    if (typeof thunk !== 'function') {
      throw new TypeError('Lazy requires a thunk function');
    }
    this.thunk = thunk;
  }

  /** Force evaluation, returning the memoized result. */
  force(): T {
    this.forces += 1;
    if (this.state === 'evaluated') {
      this.cacheHits += 1;
      return this.cached as T;
    }
    if (this.state === 'failed') {
      this.cacheHits += 1;
      throw this.error;
    }
    if (this.state === 'evaluating') {
      throw new Error('Lazy value forced recursively before evaluation completed');
    }

    this.state = 'evaluating';
    try {
      const thunk = this.thunk as () => T;
      const value = thunk();
      this.cached = value;
      this.evaluations += 1;
      this.state = 'evaluated';
      this.thunk = null;
      return value;
    } catch (err) {
      this.error = err;
      this.state = 'failed';
      this.thunk = null;
      throw err;
    }
  }

  /** Alias for `force()` for ergonomic reads. */
  get value(): T {
    return this.force();
  }

  /** True once the value has been successfully evaluated. */
  get isEvaluated(): boolean {
    return this.state === 'evaluated';
  }

  /** Compose by transforming the eventual value. */
  map<U>(fn: (value: T) => U): Lazy<U> {
    return new Lazy<U>(() => fn(this.force()));
  }

  /** Compose by chaining into another lazy computation. */
  chain<U>(fn: (value: T) => Lazy<U>): Lazy<U> {
    return new Lazy<U>(() => fn(this.force()).force());
  }

  /** Alias for `chain` (monadic bind). */
  flatMap<U>(fn: (value: T) => Lazy<U>): Lazy<U> {
    return this.chain(fn);
  }

  /** Snapshot of evaluation/caching statistics. */
  stats(): LazyStats {
    return {
      evaluations: this.evaluations,
      forces: this.forces,
      cacheHits: this.cacheHits,
      state: this.state,
    };
  }
}

/** Create a lazy value from a thunk. */
export function lazy<T>(thunk: () => T): Lazy<T> {
  return new Lazy(thunk);
}

/** Create an already-evaluated lazy value. */
export function lazyOf<T>(value: T): Lazy<T> {
  return new Lazy(() => value);
}

/** Type guard for lazy values. */
export function isLazy(value: unknown): value is Lazy<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[LAZY_BRAND] === true
  );
}
