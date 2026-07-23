import { UnknownEndpointError } from "./errors.js";
import { ValidationError } from "./errors.js";

export interface EndpointState {
  url: string;
  healthy: boolean;
  averageLatencyMs: number | null;
  consecutiveFailures: number;
  lastFailureAt: number | null;
}

export interface LoadBalancerOptions {
  maxLatencySamples?: number;
  failureThreshold?: number;
  reprobeIntervalMs?: number;
  now?: () => number;
}

interface MutableEndpointState extends EndpointState {
  latencies: number[];
}

export class LoadBalancer {
  private readonly endpoints: MutableEndpointState[];
  private readonly maxLatencySamples: number;
  private readonly failureThreshold: number;
  private readonly reprobeIntervalMs: number;
  private readonly now: () => number;
  private nextUnmeasuredIndex = 0;

  constructor(endpoints: string[], options: LoadBalancerOptions = {}) {
    if (endpoints.length === 0) {
      throw new ValidationError("LoadBalancer requires at least one endpoint.");
    }

    this.maxLatencySamples = options.maxLatencySamples ?? 10;
    this.failureThreshold = options.failureThreshold ?? 3;
    this.reprobeIntervalMs = options.reprobeIntervalMs ?? 30_000;
    this.now = options.now ?? (() => Date.now());
    this.endpoints = endpoints.map((url) => ({
      url,
      healthy: true,
      averageLatencyMs: null,
      consecutiveFailures: 0,
      lastFailureAt: null,
      latencies: [],
    }));
  }

  selectEndpoint(): string {
    const candidates = this.getSelectableEndpoints();
    const unmeasured = candidates.filter((endpoint) => endpoint.averageLatencyMs === null);

    if (unmeasured.length > 0) {
      const endpoint = unmeasured[this.nextUnmeasuredIndex % unmeasured.length]!;
      this.nextUnmeasuredIndex++;
      return endpoint.url;
    }

    return candidates.reduce((fastest, endpoint) => {
      const fastestLatency = fastest.averageLatencyMs ?? Number.POSITIVE_INFINITY;
      const endpointLatency = endpoint.averageLatencyMs ?? Number.POSITIVE_INFINITY;
      return endpointLatency < fastestLatency ? endpoint : fastest;
    }).url;
  }

  recordSuccess(url: string, latencyMs: number): void {
    const endpoint = this.findEndpoint(url);
    endpoint.latencies.push(Math.max(0, latencyMs));
    if (endpoint.latencies.length > this.maxLatencySamples) {
      endpoint.latencies.shift();
    }

    endpoint.averageLatencyMs = this.average(endpoint.latencies);
    endpoint.consecutiveFailures = 0;
    endpoint.healthy = true;
    endpoint.lastFailureAt = null;
  }

  recordFailure(url: string): void {
    const endpoint = this.findEndpoint(url);
    endpoint.consecutiveFailures++;
    endpoint.lastFailureAt = this.now();
    if (endpoint.consecutiveFailures >= this.failureThreshold) {
      endpoint.healthy = false;
    }
  }

  async request<T>(handler: (endpoint: string) => Promise<T>): Promise<T> {
    const endpoint = this.selectEndpoint();
    const startedAt = this.now();

    try {
      const result = await handler(endpoint);
      this.recordSuccess(endpoint, this.now() - startedAt);
      return result;
    } catch (error) {
      this.recordFailure(endpoint);
      throw error;
    }
  }

  getEndpointState(url: string): EndpointState {
    const endpoint = this.findEndpoint(url);
    return {
      url: endpoint.url,
      healthy: endpoint.healthy,
      averageLatencyMs: endpoint.averageLatencyMs,
      consecutiveFailures: endpoint.consecutiveFailures,
      lastFailureAt: endpoint.lastFailureAt,
    };
  }

  getEndpointStates(): EndpointState[] {
    return this.endpoints.map((endpoint) => this.getEndpointState(endpoint.url));
  }

  private getSelectableEndpoints(): MutableEndpointState[] {
    const now = this.now();
    const healthy = this.endpoints.filter((endpoint) => endpoint.healthy);
    const reprobeReady = this.endpoints.filter((endpoint) => {
      return !endpoint.healthy && endpoint.lastFailureAt !== null && now - endpoint.lastFailureAt >= this.reprobeIntervalMs;
    });

    if (healthy.length > 0) {
      return [...healthy, ...reprobeReady];
    }

    return reprobeReady.length > 0 ? reprobeReady : this.endpoints;
  }

  private findEndpoint(url: string): MutableEndpointState {
    const endpoint = this.endpoints.find((candidate) => candidate.url === url);
    if (!endpoint) {
      throw new UnknownEndpointError(url);
    }
    return endpoint;
  }

  private average(values: number[]): number {
    if (values.length === 0) {
      return 0;
    }
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }
}