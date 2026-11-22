/**
 * Ordered request/response interceptor chain with hooks and tracking.
 * Independent instances (no shared global state), unlike `interceptors.ts`.
 */

export interface InterceptRequest {
  method: string;
  params: unknown[];
  headers?: Record<string, string>;
}

export interface InterceptResponse {
  method: string;
  result: unknown;
  durationMs: number;
}

export type RequestHook = (req: InterceptRequest) => InterceptRequest | Promise<InterceptRequest>;
export type ResponseHook = (res: InterceptResponse) => InterceptResponse | Promise<InterceptResponse>;

export interface InterceptorOptions {
  /** Unique id; auto-generated when omitted. */
  id?: string;
  /** Lower runs first. Ties keep insertion order. Default 0. */
  order?: number;
}

export interface InterceptorRecord {
  id: string;
  kind: "request" | "response";
  order: number;
  invocations: number;
  failures: number;
}

interface Entry<F> {
  id: string;
  order: number;
  seq: number;
  fn: F;
  invocations: number;
  failures: number;
}

export class InterceptorError extends Error {
  constructor(
    public readonly interceptorId: string,
    public readonly cause: unknown,
  ) {
    super(
      `Interceptor "${interceptorId}" failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "InterceptorError";
  }
}

export class InterceptorChain {
  private requests: Entry<RequestHook>[] = [];
  private responses: Entry<ResponseHook>[] = [];
  private seq = 0;

  useRequest(fn: RequestHook, opts: InterceptorOptions = {}): string {
    return this.add(this.requests, fn, opts, "req");
  }

  useResponse(fn: ResponseHook, opts: InterceptorOptions = {}): string {
    return this.add(this.responses, fn, opts, "res");
  }

  /** Remove an interceptor by id. Returns true if one was removed. */
  eject(id: string): boolean {
    const before = this.requests.length + this.responses.length;
    this.requests = this.requests.filter((e) => e.id !== id);
    this.responses = this.responses.filter((e) => e.id !== id);
    return this.requests.length + this.responses.length < before;
  }

  async runRequest(req: InterceptRequest): Promise<InterceptRequest> {
    let current = req;
    for (const e of [...this.requests]) current = await this.invoke(e, current);
    return current;
  }

  async runResponse(res: InterceptResponse): Promise<InterceptResponse> {
    let current = res;
    for (const e of [...this.responses]) current = await this.invoke(e, current);
    return current;
  }

  /** Tracking info in execution order. */
  list(): InterceptorRecord[] {
    const map = (kind: "request" | "response") => (e: Entry<unknown>): InterceptorRecord => ({
      id: e.id,
      kind,
      order: e.order,
      invocations: e.invocations,
      failures: e.failures,
    });
    return [...this.requests.map(map("request")), ...this.responses.map(map("response"))];
  }

  clear(): void {
    this.requests = [];
    this.responses = [];
  }

  private add<F>(list: Entry<F>[], fn: F, opts: InterceptorOptions, prefix: string): string {
    const seq = this.seq++;
    const id = opts.id ?? `${prefix}-${seq}`;
    if (this.requests.some((e) => e.id === id) || this.responses.some((e) => e.id === id)) {
      throw new Error(`Interceptor "${id}" already exists`);
    }
    list.push({ id, order: opts.order ?? 0, seq, fn, invocations: 0, failures: 0 });
    list.sort((a, b) => a.order - b.order || a.seq - b.seq);
    return id;
  }

  private async invoke<T>(e: Entry<(v: T) => T | Promise<T>>, value: T): Promise<T> {
    e.invocations += 1;
    try {
      return await e.fn(value);
    } catch (err) {
      e.failures += 1;
      throw new InterceptorError(e.id, err);
    }
  }
}
