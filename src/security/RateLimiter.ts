/**
 * Per-user sliding-window rate limiter for {@link SplitClient}.
 */

import { RateLimitError } from "../errors.js";

export interface RateLimitConfig {
  /** Max calls allowed per window per user. Defaults to 60. */
  maxRequests?: number;
  /** Window length in milliseconds. Defaults to 60_000 (1 minute). */
  windowMs?: number;
}

export interface RateLimitEvent {
  userId: string;
  method: string;
  timestamp: number;
  allowed: boolean;
}

export class RateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly hits = new Map<string, number[]>();
  private readonly events: RateLimitEvent[] = [];
  private readonly maxEvents = 1000;

  constructor(config?: RateLimitConfig) {
    this.maxRequests = config?.maxRequests ?? 60;
    this.windowMs = config?.windowMs ?? 60_000;
  }

  /** Record a call for `userId`, throwing {@link RateLimitError} if over the limit. */
  consume(userId: string, method: string): void {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const timestamps = (this.hits.get(userId) ?? []).filter((t) => t > windowStart);

    if (timestamps.length >= this.maxRequests) {
      this._record(userId, method, now, false);
      throw new RateLimitError(
        `Rate limit exceeded for user "${userId}" calling "${method}"`,
        Math.ceil(this.windowMs / 1000),
      );
    }

    timestamps.push(now);
    this.hits.set(userId, timestamps);
    this._record(userId, method, now, true);
  }

  getEvents(): ReadonlyArray<RateLimitEvent> {
    return [...this.events];
  }

  private _record(userId: string, method: string, timestamp: number, allowed: boolean): void {
    this.events.push({ userId, method, timestamp, allowed });
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }
}
