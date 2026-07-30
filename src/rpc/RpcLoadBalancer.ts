/**
 * RpcLoadBalancer — health-weighted round-robin distribution across multiple
 * Soroban RPC endpoints.
 *
 * A single `rpcUrl` gives the SDK no resilience against a provider outage.
 * This balancer accepts a list of `EndpointConfig`s, wraps one RPC server
 * per endpoint, and picks among the *healthy* ones on every call using a
 * smooth weighted round-robin (so a higher-scoring endpoint gets picked
 * proportionally more often, not just always-the-best). Endpoints that
 * error repeatedly or blow past their latency budget are demoted into a
 * quarantine and skipped until a passing health check reinstates them. If
 * every endpoint is quarantined, the balancer still returns the
 * highest-scored one rather than failing outright.
 */

import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import { TypedEventEmitter } from "../events/TypedEventEmitter.js";

/** Sliding window used for the "3 consecutive errors" demotion rule. */
const CONSECUTIVE_ERROR_WINDOW_MS = 60_000;
/** Consecutive errors (within the window above) that trigger demotion. */
const CONSECUTIVE_ERROR_THRESHOLD = 3;

export interface EndpointConfig {
  url: string;
  /** Relative weight used in scoring. Defaults to 1. */
  weight?: number;
  /** Latency budget in ms used in scoring. Defaults to 1000. */
  maxLatencyMs?: number;
}

/**
 * The subset of `SorobanRpc.Server` the balancer actually depends on.
 * Tests can inject a fake implementation via `serverFactory` instead of
 * making real network calls; `SorobanRpc.Server` satisfies this shape.
 */
export interface RpcEndpointServer {
  getHealth(): Promise<{ status: string } | unknown>;
}

export interface RpcLoadBalancerOptions {
  /** How often endpoint scores are recomputed and quarantined endpoints re-probed. Default 30 000ms. */
  healthCheckIntervalMs?: number;
  /** How long a demoted endpoint sits in quarantine before it's eligible for a reinstatement health check. Default 60 000ms. */
  quarantineDurationMs?: number;
  /** Overrides `Date.now` for deterministic tests. */
  now?: () => number;
  /** Overrides how the underlying server for a URL is constructed. Defaults to `new SorobanRpc.Server(url, options)`. */
  serverFactory?: (url: string, options: { allowHttp?: boolean }) => RpcEndpointServer;
}

export interface EndpointSnapshot {
  url: string;
  status: "healthy" | "quarantined";
  score: number;
  errorRate: number;
  observedLatencyMs: number;
  consecutiveErrors: number;
}

export type RpcLoadBalancerEventMap = {
  "endpoint:demoted": { url: string; reason: "consecutive_errors" | "failed_health_check" };
  "endpoint:reinstated": { url: string };
};

interface EndpointRecord {
  url: string;
  server: RpcEndpointServer;
  weight: number;
  maxLatencyMs: number;
  totalCalls: number;
  errorCount: number;
  observedLatencyMs: number;
  score: number;
  currentWeight: number;
  status: "healthy" | "quarantined";
  quarantinedAt: number | null;
  recentErrorTimestamps: number[];
}

function defaultServerFactory(url: string, options: { allowHttp?: boolean }): RpcEndpointServer {
  return new SorobanRpc.Server(url, options);
}

export class RpcLoadBalancer extends TypedEventEmitter<RpcLoadBalancerEventMap> {
  private readonly endpoints: EndpointRecord[];
  private readonly healthCheckIntervalMs: number;
  private readonly quarantineDurationMs: number;
  private readonly now: () => number;
  private _timer: ReturnType<typeof setInterval> | null = null;

  constructor(configs: EndpointConfig[], options: RpcLoadBalancerOptions = {}) {
    super();
    if (!configs || configs.length === 0) {
      throw new Error("RpcLoadBalancer requires at least one endpoint.");
    }

    this.healthCheckIntervalMs = options.healthCheckIntervalMs ?? 30_000;
    this.quarantineDurationMs = options.quarantineDurationMs ?? 60_000;
    this.now = options.now ?? (() => Date.now());
    const factory = options.serverFactory ?? defaultServerFactory;

    this.endpoints = configs.map((config) => {
      const maxLatencyMs = config.maxLatencyMs ?? 1000;
      return {
        url: config.url,
        server: factory(config.url, { allowHttp: config.url.startsWith("http://") }),
        weight: config.weight ?? 1,
        maxLatencyMs,
        totalCalls: 0,
        errorCount: 0,
        // Baseline observed latency == budget, so an untested endpoint scores
        // purely on weight/errorRate until real samples come in.
        observedLatencyMs: maxLatencyMs,
        score: 0,
        currentWeight: 0,
        status: "healthy",
        quarantinedAt: null,
        recentErrorTimestamps: [],
      };
    });

    this.recomputeScores();
  }

  /** Start periodic re-scoring and quarantine re-evaluation. */
  start(): void {
    if (this._timer) return;
    this._timer = setInterval(() => {
      this.recomputeScores();
      void this.runHealthChecks();
    }, this.healthCheckIntervalMs);
    this._timer.unref?.();
  }

  /** Stop the periodic timer started by `start()`. */
  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  private recomputeScores(): void {
    for (const endpoint of this.endpoints) {
      const errorRate = endpoint.totalCalls === 0 ? 0 : endpoint.errorCount / endpoint.totalCalls;
      const latencyRatio = endpoint.maxLatencyMs / Math.max(endpoint.observedLatencyMs, 1);
      endpoint.score = endpoint.weight * (1 / (errorRate + 0.01)) * latencyRatio;
    }
  }

  /**
   * Pick the next endpoint via smooth weighted round-robin among healthy
   * endpoints. If every endpoint is quarantined, falls back to the
   * highest-scored one instead of failing.
   */
  selectEndpoint(): { url: string; server: RpcEndpointServer } {
    const healthy = this.endpoints.filter((e) => e.status === "healthy");

    if (healthy.length === 0) {
      const best = this.endpoints.reduce((a, b) => (b.score > a.score ? b : a));
      return { url: best.url, server: best.server };
    }

    const totalWeight = healthy.reduce((sum, e) => sum + e.score, 0);
    for (const e of healthy) e.currentWeight += e.score;

    const selected = healthy.reduce((a, b) => (b.currentWeight > a.currentWeight ? b : a));
    selected.currentWeight -= totalWeight;

    return { url: selected.url, server: selected.server };
  }

  /**
   * Run `fn` against the selected endpoint's server, recording latency and
   * success/failure for scoring and demotion purposes.
   */
  async execute<T>(fn: (server: RpcEndpointServer) => Promise<T>): Promise<T> {
    const { url, server } = this.selectEndpoint();
    const startedAt = this.now();
    try {
      const result = await fn(server);
      this.recordResult(url, { success: true, latencyMs: this.now() - startedAt });
      return result;
    } catch (error) {
      this.recordResult(url, { success: false, latencyMs: this.now() - startedAt });
      throw error;
    }
  }

  /** Record the outcome of a call against `url` (exposed for direct/deterministic testing). */
  recordResult(url: string, outcome: { success: boolean; latencyMs: number }): void {
    const endpoint = this.findEndpoint(url);
    endpoint.totalCalls++;
    // Exponential moving average keeps recent latency dominant without
    // needing an unbounded sample buffer.
    endpoint.observedLatencyMs = endpoint.totalCalls === 1
      ? Math.max(outcome.latencyMs, 1)
      : endpoint.observedLatencyMs * 0.7 + outcome.latencyMs * 0.3;

    if (outcome.success) {
      endpoint.recentErrorTimestamps = [];
    } else {
      endpoint.errorCount++;
      endpoint.recentErrorTimestamps.push(this.now());
      endpoint.recentErrorTimestamps = endpoint.recentErrorTimestamps.filter(
        (t) => this.now() - t <= CONSECUTIVE_ERROR_WINDOW_MS,
      );
      if (
        endpoint.status === "healthy" &&
        endpoint.recentErrorTimestamps.length >= CONSECUTIVE_ERROR_THRESHOLD
      ) {
        this.demote(endpoint, "consecutive_errors");
      }
    }

    this.recomputeScores();
  }

  /**
   * Re-probe quarantined endpoints whose `quarantineDurationMs` has
   * elapsed. Reinstates on a passing `getHealth()` call; otherwise resets
   * the quarantine clock for another round.
   */
  async runHealthChecks(): Promise<void> {
    const due = this.endpoints.filter(
      (e) =>
        e.status === "quarantined" &&
        e.quarantinedAt !== null &&
        this.now() - e.quarantinedAt >= this.quarantineDurationMs,
    );

    await Promise.all(
      due.map(async (endpoint) => {
        try {
          await endpoint.server.getHealth();
          this.reinstate(endpoint);
        } catch {
          // Still unhealthy — restart the quarantine clock for another round.
          endpoint.quarantinedAt = this.now();
        }
      }),
    );
  }

  private demote(endpoint: EndpointRecord, reason: "consecutive_errors" | "failed_health_check"): void {
    if (endpoint.status === "quarantined") return;
    endpoint.status = "quarantined";
    endpoint.quarantinedAt = this.now();
    this.emit("endpoint:demoted", { url: endpoint.url, reason });
  }

  private reinstate(endpoint: EndpointRecord): void {
    endpoint.status = "healthy";
    endpoint.quarantinedAt = null;
    endpoint.errorCount = 0;
    endpoint.totalCalls = 0;
    endpoint.recentErrorTimestamps = [];
    this.recomputeScores();
    this.emit("endpoint:reinstated", { url: endpoint.url });
  }

  /** Snapshot of every endpoint's current state, for introspection/testing. */
  getEndpointStates(): EndpointSnapshot[] {
    return this.endpoints.map((e) => ({
      url: e.url,
      status: e.status,
      score: e.score,
      errorRate: e.totalCalls === 0 ? 0 : e.errorCount / e.totalCalls,
      observedLatencyMs: e.observedLatencyMs,
      consecutiveErrors: e.recentErrorTimestamps.length,
    }));
  }

  private findEndpoint(url: string): EndpointRecord {
    const endpoint = this.endpoints.find((e) => e.url === url);
    if (!endpoint) {
      throw new Error(`RpcLoadBalancer: unknown endpoint "${url}"`);
    }
    return endpoint;
  }
}
