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
export type WildcardEventHandler<T extends EventMap> = (
  event: keyof T,
  payload: T[keyof T],
) => void;

export class TypedEventEmitter<T extends EventMap> {
  private listeners: { [K in keyof T]?: Set<(payload: T[K]) => void> } = {};
  private wildcardListeners = new Set<WildcardEventHandler<T>>();

  /**
   * Register a handler for `event`. Returns an unsubscribe function.
   */
  on<K extends keyof T>(event: K, handler: (payload: T[K]) => void): Unsubscribe;
  on(event: "*", handler: WildcardEventHandler<T>): Unsubscribe;
  on(event: keyof T | "*", handler: ((payload: never) => void) | WildcardEventHandler<T>): Unsubscribe {
    if (event === "*") {
      const wildcardHandler = handler as WildcardEventHandler<T>;
      this.wildcardListeners.add(wildcardHandler);
      return () => this.wildcardListeners.delete(wildcardHandler);
    }

    const typedHandler = handler as (payload: T[typeof event]) => void;
    let set = this.listeners[event];
    if (!set) {
      set = new Set();
      this.listeners[event] = set;
    }
    set.add(typedHandler);
    return () => set!.delete(typedHandler);
  }

  /**
   * Remove a previously registered handler for `event`. No-op if the handler
   * was never registered (or already removed).
   */
  off<K extends keyof T>(event: K, handler: (payload: T[K]) => void): void;
  off(event: "*", handler: WildcardEventHandler<T>): void;
  off(event: keyof T | "*", handler: ((payload: never) => void) | WildcardEventHandler<T>): void {
    if (event === "*") {
      this.wildcardListeners.delete(handler as WildcardEventHandler<T>);
      return;
    }

    const typedHandler = handler as (payload: T[typeof event]) => void;
    this.listeners[event]?.delete(typedHandler);
  }

  /**
   * Synchronously invoke every handler registered for `event` with `payload`.
   */
  emit<K extends keyof T>(event: K, payload: T[K]): void {
    const set = this.listeners[event];
    if (set && set.size > 0) {
      for (const handler of Array.from(set)) {
        handler(payload);
      }
    }

    if (this.wildcardListeners.size > 0) {
      for (const handler of Array.from(this.wildcardListeners)) {
        handler(event, payload);
      }
    }
  }

  /**
   * Resolve with the payload of the next `event` emission. If `signal` is
   * provided and fires before the event, the promise rejects with an
   * {@link AbortError} instead.
   */
  once<K extends keyof T>(event: K, signal?: AbortSignal): Promise<T[K]>;
  once(event: "*", signal?: AbortSignal): Promise<{ event: keyof T; payload: T[keyof T] }>;
  once(event: keyof T | "*", signal?: AbortSignal): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
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

      if (event === "*") {
        unsubscribe = this.on("*", (eventName, payload) => {
          signal?.removeEventListener("abort", onAbort);
          unsubscribe();
          resolve({ event: eventName, payload });
        });
      } else {
        unsubscribe = this.on(event, (payload) => {
          signal?.removeEventListener("abort", onAbort);
          unsubscribe();
          resolve(payload);
        });
      }

      signal?.addEventListener("abort", onAbort);
    });
  }

  /** Remove all handlers for `event`, or every handler for every event if omitted. */
  removeAllListeners(): void;
  removeAllListeners<K extends keyof T>(event: K): void;
  removeAllListeners(event: "*"): void;
  removeAllListeners(event?: keyof T | "*"): void {
    if (event === undefined) {
      this.listeners = {};
      this.wildcardListeners.clear();
    } else if (event === "*") {
      this.wildcardListeners.clear();
    } else {
      delete this.listeners[event];
    }
  }

  /** Number of handlers currently registered for `event`. */
  listenerCount<K extends keyof T>(event: K): number;
  listenerCount(event: "*"): number;
  listenerCount(event: keyof T | "*"): number {
    if (event === "*") {
      return this.wildcardListeners.size;
    }
    return this.listeners[event]?.size ?? 0;
  }
}
