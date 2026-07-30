/**
 * Zero-dependency, strongly-typed event emitter usable in Node, browser, and
 * edge runtimes (no dependency on Node's `events` module).
 *
 * `T` maps event names to their payload type, giving compile-time safety on
 * both `emit()` calls and `on()`/`once()` handlers:
 *
 * ```ts
 * interface MyEvents {
 *   greeting: { name: string };
 * }
 *
 * const emitter = new TypedEventEmitter<MyEvents>();
 * emitter.on("greeting", (payload) => console.log(payload.name));
 * emitter.emit("greeting", { name: "Ada" });
 * ```
 */

/** Call to remove the handler that was registered via {@link TypedEventEmitter.on}. */
export type Unsubscribe = () => void;

/** Thrown by {@link TypedEventEmitter.once} when the supplied AbortSignal fires first. */
export class AbortError extends Error {
  constructor(message = "The operation was aborted") {
    super(message);
    this.name = "AbortError";
  }
}

export type EventMap = Record<string, unknown>;

export class TypedEventEmitter<T extends EventMap> {
  private listeners: { [K in keyof T]?: Set<(payload: T[K]) => void> } = {};

  /**
   * Register a handler for `event`. Returns an unsubscribe function.
   */
  on<K extends keyof T>(event: K, handler: (payload: T[K]) => void): Unsubscribe {
    let set = this.listeners[event];
    if (!set) {
      set = new Set();
      this.listeners[event] = set;
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  /**
   * Remove a previously registered handler for `event`. No-op if the handler
   * was never registered (or already removed).
   */
  off<K extends keyof T>(event: K, handler: (payload: T[K]) => void): void {
    this.listeners[event]?.delete(handler);
  }

  /**
   * Synchronously invoke every handler registered for `event` with `payload`.
   */
  emit<K extends keyof T>(event: K, payload: T[K]): void {
    const set = this.listeners[event];
    if (!set || set.size === 0) return;
    for (const handler of Array.from(set)) {
      handler(payload);
    }
  }

  /**
   * Resolve with the payload of the next `event` emission. If `signal` is
   * provided and fires before the event, the promise rejects with an
   * {@link AbortError} instead.
   */
  once<K extends keyof T>(event: K, signal?: AbortSignal): Promise<T[K]> {
    return new Promise<T[K]>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new AbortError());
        return;
      }

      let unsubscribe: Unsubscribe;

      const onAbort = () => {
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
        reject(new AbortError());
      };

      unsubscribe = this.on(event, (payload) => {
        signal?.removeEventListener("abort", onAbort);
        unsubscribe();
        resolve(payload);
      });

      signal?.addEventListener("abort", onAbort);
    });
  }

  /** Remove all handlers for `event`, or every handler for every event if omitted. */
  removeAllListeners<K extends keyof T>(event?: K): void {
    if (event === undefined) {
      this.listeners = {};
    } else {
      delete this.listeners[event];
    }
  }

  /** Number of handlers currently registered for `event`. */
  listenerCount<K extends keyof T>(event: K): number {
    return this.listeners[event]?.size ?? 0;
  }
}
