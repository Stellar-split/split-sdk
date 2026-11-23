/** Issue #1295: SDK middleware chain with hooks, plugins and tracking. */

export interface SdkContext {
  operation: string;
  params: unknown;
  result?: unknown;
  [key: string]: unknown;
}

export type SdkNext = () => Promise<unknown>;
export type SdkMiddleware = (ctx: SdkContext, next: SdkNext) => Promise<unknown>;

export interface SdkMiddlewarePlugin {
  name: string;
  middleware: SdkMiddleware;
}

export interface SdkMiddlewareStats {
  calls: number;
  errors: number;
  totalMs: number;
}

export class SdkMiddlewareChain {
  private entries: Array<{ name: string; fn: SdkMiddleware }> = [];
  private tracking = new Map<string, SdkMiddlewareStats>();

  use(name: string, fn: SdkMiddleware): this {
    this.entries.push({ name, fn });
    this.tracking.set(name, { calls: 0, errors: 0, totalMs: 0 });
    return this;
  }

  /** Register a plugin (named middleware). */
  plugin(p: SdkMiddlewarePlugin): this {
    return this.use(p.name, p.middleware);
  }

  /** Convenience hooks wrapping an operation. */
  hooks(name: string, h: { before?: (c: SdkContext) => void | Promise<void>; after?: (c: SdkContext) => void | Promise<void> }): this {
    return this.use(name, async (ctx, next) => {
      await h.before?.(ctx);
      const r = await next();
      ctx.result = r;
      await h.after?.(ctx);
      return r;
    });
  }

  async run(ctx: SdkContext, handler: (ctx: SdkContext) => Promise<unknown>): Promise<unknown> {
    const dispatch = (i: number): Promise<unknown> => {
      const e = this.entries[i];
      if (!e) return handler(ctx);
      const s = this.tracking.get(e.name)!;
      const start = Date.now();
      s.calls++;
      return e.fn(ctx, () => dispatch(i + 1)).catch((err) => {
        s.errors++;
        throw err;
      }).finally(() => {
        s.totalMs += Date.now() - start;
      });
    };
    return dispatch(0);
  }

  stats(): Record<string, SdkMiddlewareStats> {
    return Object.fromEntries(this.tracking);
  }
}
