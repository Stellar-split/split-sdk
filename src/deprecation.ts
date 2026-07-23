/**
 * SDK method deprecation warning system.
 *
 * Wraps exported functions to emit a one-time-per-method console warning
 * when a deprecated method is called, without altering behavior.
 */

export interface DeprecationOptions {
  removedInVersion: string;
  alternative: string;
}

const warned = new Set<string>();

export function resetDeprecationWarnings(): void {
  warned.clear();
}

export function deprecated<T extends (...args: any[]) => any>(
  methodName: string,
  options: DeprecationOptions,
  fn: T,
): T {
  const wrapper = function (this: any, ...args: any[]) {
    if (!warned.has(methodName)) {
      warned.add(methodName);
      console.warn(
        `[StellarSplit] "${methodName}" is deprecated and will be removed in v${options.removedInVersion}. ` +
          `Use "${options.alternative}" instead.`,
      );
    }
    return fn.apply(this, args);
  } as unknown as T;

  return wrapper;
}
