/**
 * CORS handling for browser-based SDK usage.
 *
 * Resolves origins (including asynchronous allow-list predicates), answers
 * preflight requests, applies credential-safe header rules and keeps a bounded
 * tracking trail. The handler is transport-agnostic: it consumes a small
 * request shape and returns headers that any HTTP layer can apply.
 */

/** Rule describing which origins may access the resource. */
export type CorsOriginRule =
  | string
  | string[]
  | true
  | ((origin: string) => boolean | Promise<boolean>);

/** Minimal request shape needed to make a CORS decision. */
export interface CorsRequest {
  method: string;
  origin?: string | null;
  headers?: Record<string, string | string[] | undefined>;
}

/** Result of evaluating a request. */
export interface CorsDecision {
  allowed: boolean;
  isPreflight: boolean;
  headers: Record<string, string>;
  reason?: string;
}

/** Bounded diagnostic record of one CORS evaluation. */
export interface CorsEvent {
  timestamp: number;
  origin: string;
  method: string;
  isPreflight: boolean;
  allowed: boolean;
  reason?: string;
}

/** Counters describing CORS decisions. */
export interface CorsStats {
  requests: number;
  preflights: number;
  allowed: number;
  denied: number;
}

/** Configuration for {@link CorsHandler}. */
export interface CorsOptions {
  /** Allowed origins. Defaults to `*` (reflected when credentials are enabled). */
  origins?: CorsOriginRule;
  /** Methods advertised on preflight. */
  methods?: string[];
  /** Headers clients may send on actual requests. */
  allowedHeaders?: string[];
  /** Response headers exposed to browser code. */
  exposedHeaders?: string[];
  /** Whether browsers may include credentials. Defaults to false. */
  credentials?: boolean;
  /** Preflight cache lifetime in seconds. Defaults to 600. */
  maxAge?: number;
  /** Maximum number of retained tracking events. Defaults to 100. */
  maxTrackedEvents?: number;
  /** Injectable clock. */
  now?: () => number;
}

const DEFAULT_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const DEFAULT_ALLOWED_HEADERS = [
  "Content-Type",
  "Authorization",
  "X-Requested-With",
  "X-Stellar-Split-Trace-Id",
];

function headerValue(headers: CorsRequest["headers"], name: string): string | undefined {
  if (!headers) {
    return undefined;
  }
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  if (!key) {
    return undefined;
  }
  const value = headers[key];
  return Array.isArray(value) ? value.join(", ") : value;
}

/** Evaluate browser CORS rules for the StellarSplit SDK. */
export class CorsHandler {
  private readonly options: Required<
    Pick<CorsOptions, "origins" | "methods" | "allowedHeaders" | "exposedHeaders" | "credentials" | "maxAge" | "maxTrackedEvents">
  > &
    CorsOptions;
  private readonly events: CorsEvent[] = [];
  private counters: CorsStats = { requests: 0, preflights: 0, allowed: 0, denied: 0 };

  constructor(options: CorsOptions = {}) {
    this.options = {
      ...options,
      origins: options.origins ?? "*",
      methods: options.methods ?? DEFAULT_METHODS,
      allowedHeaders: options.allowedHeaders ?? DEFAULT_ALLOWED_HEADERS,
      exposedHeaders: options.exposedHeaders ?? [],
      credentials: options.credentials ?? false,
      maxAge: options.maxAge ?? 600,
      maxTrackedEvents: options.maxTrackedEvents ?? 100,
    };
  }

  /** Evaluate a request and return the decision plus headers to apply. */
  async handle(request: CorsRequest): Promise<CorsDecision> {
    const origin = request.origin ?? "";
    const method = (request.method || "GET").toUpperCase();
    const isPreflight =
      method === "OPTIONS" && Boolean(headerValue(request.headers, "access-control-request-method"));

    this.counters.requests += 1;
    if (isPreflight) {
      this.counters.preflights += 1;
    }

    let decision: CorsDecision;
    if (!origin) {
      // Non-browser / same-origin requests need no CORS headers.
      decision = { allowed: true, isPreflight, headers: {} };
    } else {
      decision = await this.evaluateOrigin(origin, method, request, isPreflight);
    }

    if (decision.allowed) {
      this.counters.allowed += 1;
    } else {
      this.counters.denied += 1;
    }
    this.track({
      timestamp: this.now(),
      origin: origin || "(none)",
      method,
      isPreflight,
      allowed: decision.allowed,
      reason: decision.reason,
    });
    return decision;
  }

  /** Check an origin against the configured rule without building headers. */
  async isOriginAllowed(origin: string): Promise<boolean> {
    if (!origin) {
      return true;
    }
    const rule = this.options.origins;
    if (rule === true) {
      return true;
    }
    if (typeof rule === "string") {
      return rule === "*" || rule === origin;
    }
    if (Array.isArray(rule)) {
      return rule.includes("*") || rule.includes(origin);
    }
    return Boolean(await rule(origin));
  }

  /** Operation counters. */
  stats(): CorsStats {
    return { ...this.counters };
  }

  /** Copy of the bounded CORS decision trail. */
  eventsTrail(): CorsEvent[] {
    return this.events.map((event) => ({ ...event }));
  }

  /** Reset counters and tracking history. */
  reset(): void {
    this.events.length = 0;
    this.counters = { requests: 0, preflights: 0, allowed: 0, denied: 0 };
  }

  private async evaluateOrigin(
    origin: string,
    method: string,
    request: CorsRequest,
    isPreflight: boolean,
  ): Promise<CorsDecision> {
    if (!(await this.isOriginAllowed(origin))) {
      return {
        allowed: false,
        isPreflight,
        headers: { Vary: "Origin" },
        reason: "origin-not-allowed",
      };
    }

    const headers: Record<string, string> = { Vary: "Origin" };
    const wildcard = this.resolvesToWildcard();
    headers["Access-Control-Allow-Origin"] = wildcard && !this.options.credentials ? "*" : origin;
    if (this.options.credentials) {
      headers["Access-Control-Allow-Credentials"] = "true";
    }

    if (isPreflight) {
      const requestedMethod = (headerValue(request.headers, "access-control-request-method") ?? "").toUpperCase();
      const requestedHeaders = (headerValue(request.headers, "access-control-request-headers") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);

      if (!this.options.methods.some((candidate) => candidate.toUpperCase() === requestedMethod)) {
        return {
          allowed: false,
          isPreflight,
          headers: { Vary: "Origin" },
          reason: "method-not-allowed",
        };
      }

      const allowed = new Set(this.options.allowedHeaders.map((name) => name.toLowerCase()));
      const unsupported = requestedHeaders.filter((name) => !allowed.has(name.toLowerCase()));
      if (unsupported.length > 0) {
        return {
          allowed: false,
          isPreflight,
          headers: { Vary: "Origin" },
          reason: "headers-not-allowed",
        };
      }

      headers["Access-Control-Allow-Methods"] = this.options.methods.join(", ");
      headers["Access-Control-Allow-Headers"] =
        requestedHeaders.length > 0 ? requestedHeaders.join(", ") : this.options.allowedHeaders.join(", ");
      headers["Access-Control-Max-Age"] = String(this.options.maxAge);
      // Avoid a '*' with credentials on preflights as well.
      if (this.options.credentials && headers["Access-Control-Allow-Headers"] === "*") {
        headers["Access-Control-Allow-Headers"] = this.options.allowedHeaders.join(", ");
      }
    } else if (this.options.exposedHeaders.length > 0) {
      headers["Access-Control-Expose-Headers"] = this.options.exposedHeaders.join(", ");
    }

    return { allowed: true, isPreflight, headers };
  }

  private resolvesToWildcard(): boolean {
    const rule = this.options.origins;
    return rule === true || rule === "*" || (Array.isArray(rule) && rule.includes("*"));
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private track(event: CorsEvent): void {
    if (this.events.length >= this.options.maxTrackedEvents) {
      this.events.shift();
    }
    this.events.push(event);
  }
}
