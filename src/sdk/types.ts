/**
 * SDK type definitions.
 */

/**
 * Configuration for SDK request deduplication.
 */
export interface DeduplicationConfig {
  /**
   * Enable deduplication of identical concurrent requests.
   * @default true
   */
  enabled?: boolean;
  /**
   * Time-to-live (ms) for cached responses. Set to 0 to disable caching.
   * @default 0
   */
  cacheTtlMs?: number;
  /**
   * Maximum time (ms) a deduped request may wait before timing out.
   * @default 30000
   */
  timeoutMs?: number;
  /**
   * Maximum number of cached entries to retain.
   * @default 100
   */
  maxCacheSize?: number;
}

/**
 * Statistics describing deduplication activity.
 */
export interface DeduplicationStats {
  /** Total requests observed. */
  totalRequests: number;
  /** Requests coalesced into an existing in-flight request. */
  deduplicatedRequests: number;
  /** Requests served from the response cache. */
  cacheHits: number;
  /** Requests that timed out while waiting. */
  timeouts: number;
  /** Number of requests that actually hit the network. */
  networkRequests: number;
}

/**
 * Identity used to key deduplicated requests.
 */
export interface RequestIdentity {
  method: string;
  path: string;
  params?: Record<string, unknown>;
}
