/** Minimal dependency injection container with lifecycles and parent inheritance. */

export type Lifecycle = "singleton" | "transient";
export type Factory<T> = (container: DIContainer) => T;

interface Registration<T = unknown> {
  factory: Factory<T>;
  lifecycle: Lifecycle;
  instance?: T;
  resolved?: boolean;
  dispose?: (instance: T) => void;
}

export class DIContainer {
  private registrations = new Map<string, Registration>();
  private resolutions = new Map<string, number>();
  private resolving: string[] = [];

  constructor(private parent?: DIContainer) {}

  register<T>(
    token: string,
    factory: Factory<T>,
    opts: { lifecycle?: Lifecycle; dispose?: (instance: T) => void } = {}
  ): this {
    this.registrations.set(token, {
      factory,
      lifecycle: opts.lifecycle ?? "singleton",
      dispose: opts.dispose as ((i: unknown) => void) | undefined,
    });
    return this;
  }

  registerValue<T>(token: string, value: T): this {
    return this.register(token, () => value);
  }

  has(token: string): boolean {
    return this.registrations.has(token) || (this.parent?.has(token) ?? false);
  }

  resolve<T>(token: string): T {
    const reg = this.registrations.get(token);
    if (!reg) {
      if (this.parent) return this.parent.resolve<T>(token);
      throw new Error(`No provider registered for "${token}"`);
    }
    if (this.resolving.includes(token)) {
      throw new Error(`Circular dependency: ${[...this.resolving, token].join(" -> ")}`);
    }
    if (reg.lifecycle === "singleton" && reg.resolved) return reg.instance as T;

    this.resolving.push(token);
    try {
      const instance = reg.factory(this) as T;
      if (reg.lifecycle === "singleton") {
        reg.instance = instance;
        reg.resolved = true;
      }
      this.resolutions.set(token, (this.resolutions.get(token) ?? 0) + 1);
      return instance;
    } finally {
      this.resolving.pop();
    }
  }

  /** Create a child container that falls back to this one. */
  createChild(): DIContainer {
    return new DIContainer(this);
  }

  /** Number of times each token's factory ran in this container. */
  getResolutionCounts(): Record<string, number> {
    return Object.fromEntries(this.resolutions);
  }

  /** Dispose resolved singletons in this container and clear registrations. */
  dispose(): void {
    for (const reg of this.registrations.values()) {
      if (reg.resolved && reg.dispose) reg.dispose(reg.instance);
    }
    this.registrations.clear();
  }
}
