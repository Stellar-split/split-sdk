/**
 * Webhook client library for receiving, verifying, and processing StellarSplit webhooks.
 */

import { createHmac, timingSafeEqual } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";

export interface WebhookRetryConfig {
  /** Maximum number of attempts (including the first). Default: 3. */
  maxAttempts?: number;
  /** Base delay in milliseconds between retries. Default: 100. */
  baseDelayMs?: number;
  /** Maximum delay in milliseconds between retries. Default: 5000. */
  maxDelayMs?: number;
  /** Multiplier applied to the delay after each attempt. Default: 2. */
  backoffMultiplier?: number;
  /** Whether to add random jitter to the delay. Default: true. */
  jitter?: boolean;
}

export interface WebhookClientStats {
  /** Total number of webhooks received by process(). */
  received: number;
  /** Number of webhooks successfully verified and processed. */
  processed: number;
  /** Number of webhooks that failed verification or processing. */
  failed: number;
  /** Number of handler executions that were retried. */
  retried: number;
  /** Number of retry attempts that ultimately succeeded. */
  retrySucceeded: number;
  /** Number of retry attempts that ultimately failed. */
  retryFailed: number;
}

export interface WebhookClientConfig {
  /** The shared HMAC secret configured for the webhook endpoint. */
  secret: string;
  /** Maximum allowed timestamp skew in seconds to prevent replay attacks. Default: 300 (5 minutes). */
  toleranceSeconds?: number;
  /** Header name for signature. Default: "x-stellar-split-signature". */
  signatureHeader?: string;
  /** Header name for timestamp. Default: "x-stellar-split-timestamp". */
  timestampHeader?: string;
  /** Header name for event name. Default: "x-stellar-split-event". */
  eventHeader?: string;
  /** Whether process() throws errors or returns them in the result object. Default: true. */
  throwOnError?: boolean;
  /** Retry configuration for failed handler execution. */
  retry?: WebhookRetryConfig;
}

export interface WebhookEventPayload<T = unknown> {
  id?: string;
  event: string;
  invoiceId?: string;
  timestamp: string | number;
  data: T;
  [key: string]: unknown;
}

export interface WebhookProcessResult<T = unknown> {
  success: boolean;
  event?: WebhookEventPayload<T>;
  handlersExecuted: number;
  error?: Error;
  timestamp?: number;
  /** Number of retry attempts performed for handler execution. */
  retries?: number;
}

export type WebhookHandler<T = unknown> = (
  payload: WebhookEventPayload<T>,
) => void | Promise<void>;

export type WebhookErrorHandler = (
  error: Error,
  rawBody?: string,
  headers?: Record<string, string | string[] | undefined>,
) => void | Promise<void>;

export type WebhookClientMiddleware = (
  payload: WebhookEventPayload,
  next: () => Promise<void>,
) => Promise<void>;

export type WebhookMiddleware = WebhookClientMiddleware;

// ---------------------------------------------------------------------------
// Custom Errors
// ---------------------------------------------------------------------------

export class WebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class WebhookVerificationError extends WebhookError {
  constructor(message = "Webhook signature verification failed") {
    super(message);
    this.name = "WebhookVerificationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class WebhookTimestampError extends WebhookError {
  readonly timestamp: number;
  readonly toleranceSeconds: number;

  constructor(message: string, timestamp: number, toleranceSeconds: number) {
    super(message);
    this.name = "WebhookTimestampError";
    this.timestamp = timestamp;
    this.toleranceSeconds = toleranceSeconds;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class WebhookPayloadMalformedError extends WebhookError {
  constructor(message = "Webhook payload is malformed or invalid JSON") {
    super(message);
    this.name = "WebhookPayloadMalformedError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Webhook Client
// ---------------------------------------------------------------------------

export class WebhookClient {
  private readonly secret: string;
  private readonly toleranceSeconds: number;
  private readonly signatureHeader: string;
  private readonly timestampHeader: string;
  private readonly eventHeader: string;
  private readonly throwOnError: boolean;
  private readonly retryConfig: Required<WebhookRetryConfig>;

  private readonly handlers = new Map<string, Set<WebhookHandler>>();
  private readonly onceHandlers = new Map<string, Set<WebhookHandler>>();
  private readonly errorHandlers = new Set<WebhookErrorHandler>();
  private readonly middlewares: WebhookMiddleware[] = [];

  private readonly stats: WebhookClientStats = {
    received: 0,
    processed: 0,
    failed: 0,
    retried: 0,
    retrySucceeded: 0,
    retryFailed: 0,
  };

  constructor(config: WebhookClientConfig) {
    if (!config || !config.secret) {
      throw new TypeError("WebhookClient requires a secret HMAC key");
    }
    this.secret = config.secret;
    this.toleranceSeconds = config.toleranceSeconds ?? 300;
    this.signatureHeader = (config.signatureHeader ?? "x-stellar-split-signature").toLowerCase();
    this.timestampHeader = (config.timestampHeader ?? "x-stellar-split-timestamp").toLowerCase();
    this.eventHeader = (config.eventHeader ?? "x-stellar-split-event").toLowerCase();
    this.throwOnError = config.throwOnError ?? true;
    this.retryConfig = {
      maxAttempts: Math.max(1, config.retry?.maxAttempts ?? 3),
      baseDelayMs: Math.max(0, config.retry?.baseDelayMs ?? 100),
      maxDelayMs: Math.max(0, config.retry?.maxDelayMs ?? 5000),
      backoffMultiplier: Math.max(1, config.retry?.backoffMultiplier ?? 2),
      jitter: config.retry?.jitter ?? true,
    };
  }

  /**
   * Return a snapshot of the webhook processing statistics.
   */
  getStats(): WebhookClientStats {
    return { ...this.stats };
  }

  /**
   * Reset the webhook processing statistics.
   */
  resetStats(): void {
    this.stats.received = 0;
    this.stats.processed = 0;
    this.stats.failed = 0;
    this.stats.retried = 0;
    this.stats.retrySucceeded = 0;
    this.stats.retryFailed = 0;
  }

  private computeRetryDelay(attempt: number): number {
    const { baseDelayMs, maxDelayMs, backoffMultiplier, jitter } = this.retryConfig;
    const exponential = baseDelayMs * Math.pow(backoffMultiplier, attempt - 1);
    const capped = Math.min(exponential, maxDelayMs);
    if (!jitter) return capped;
    return Math.floor(Math.random() * capped);
  }

  private async executeWithRetry<T>(fn: () => Promise<T>): Promise<{ result: T; retries: number }> {
    const { maxAttempts } = this.retryConfig;
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await fn();
        if (attempt > 1) {
          this.stats.retrySucceeded++;
        }
        return { result, retries: attempt - 1 };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxAttempts) {
          this.stats.retried++;
          const delay = this.computeRetryDelay(attempt);
          if (delay > 0) {
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        } else {
          this.stats.retryFailed++;
        }
      }
    }
    throw lastError ?? new WebhookError("Handler execution failed");
  }

  /**
   * Register an event handler for a specific event type (e.g. "payment", "released", "refunded")
   * or "*" to receive all events.
   */
  on<T = unknown>(event: string, handler: WebhookHandler<T>): this {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as WebhookHandler);
    return this;
  }

  /**
   * Register a one-time event handler.
   */
  once<T = unknown>(event: string, handler: WebhookHandler<T>): this {
    let set = this.onceHandlers.get(event);
    if (!set) {
      set = new Set();
      this.onceHandlers.set(event, set);
    }
    set.add(handler as WebhookHandler);
    return this;
  }

  /**
   * Remove a registered event handler.
   */
  off<T = unknown>(event: string, handler: WebhookHandler<T>): this {
    this.handlers.get(event)?.delete(handler as WebhookHandler);
    this.onceHandlers.get(event)?.delete(handler as WebhookHandler);
    return this;
  }

  /**
   * Register an error handler.
   */
  onError(handler: WebhookErrorHandler): this {
    this.errorHandlers.add(handler);
    return this;
  }

  /**
   * Register middleware executed before handlers.
   */
  use(middleware: WebhookMiddleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  /**
   * Helper to compute an expected HMAC-SHA256 signature for testing or manual signing.
   */
  computeSignature(payload: string | Buffer, timestamp?: number): { signature: string; timestamp: number } {
    const ts = timestamp ?? Math.floor(Date.now() / 1000);
    const bodyStr = typeof payload === "string" ? payload : payload.toString("utf8");
    const signatureContent = `${ts}.${bodyStr}`;
    const signature = createHmac("sha256", this.secret).update(signatureContent).digest("hex");
    return { signature, timestamp: ts };
  }

  /**
   * Verify an incoming signature and timestamp against the raw body.
   */
  verify(
    rawBody: string | Buffer,
    signatureHeader: string,
    timestampHeader?: string,
  ): { valid: boolean; timestamp: number; reason?: string } {
    const bodyStr = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");

    let timestamp: number;
    let expectedSig: string;

    // Check if signature header is in format "t=12345678,v1=abcdef..."
    if (signatureHeader.includes("t=") && signatureHeader.includes("v1=")) {
      const parts = signatureHeader.split(",");
      const tPart = parts.find((p) => p.trim().startsWith("t="))?.trim().slice(2);
      const v1Part = parts.find((p) => p.trim().startsWith("v1="))?.trim().slice(3);

      if (!tPart || !v1Part) {
        return { valid: false, timestamp: 0, reason: "Malformed signature header format" };
      }
      timestamp = Number(tPart);
      expectedSig = v1Part;
    } else {
      if (!timestampHeader) {
        // Fallback: check if signature was computed over raw body directly without timestamp
        const directExpected = createHmac("sha256", this.secret).update(bodyStr).digest();
        if (/^[0-9a-f]+$/i.test(signatureHeader) && signatureHeader.length % 2 === 0) {
          const directProvided = Buffer.from(signatureHeader, "hex");
          if (directExpected.length === directProvided.length && timingSafeEqual(directExpected, directProvided)) {
            return { valid: true, timestamp: Math.floor(Date.now() / 1000) };
          }
        }
        return { valid: false, timestamp: 0, reason: "Missing timestamp" };
      }
      timestamp = Number(timestampHeader);
      expectedSig = signatureHeader;
    }

    if (isNaN(timestamp) || timestamp <= 0) {
      return { valid: false, timestamp: 0, reason: "Invalid timestamp" };
    }

    // Verify freshness against tolerance
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > this.toleranceSeconds) {
      return {
        valid: false,
        timestamp,
        reason: `Timestamp ${timestamp} outside tolerance of ${this.toleranceSeconds}s (drift: ${Math.abs(now - timestamp)}s)`,
      };
    }

    // Compute expected HMAC
    const computedDigest = createHmac("sha256", this.secret)
      .update(`${timestamp}.${bodyStr}`)
      .digest();

    if (!/^[0-9a-f]+$/i.test(expectedSig) || expectedSig.length % 2 !== 0) {
      return { valid: false, timestamp, reason: "Invalid hex signature format" };
    }

    const providedDigest = Buffer.from(expectedSig, "hex");
    if (computedDigest.length !== providedDigest.length) {
      return { valid: false, timestamp, reason: "Signature length mismatch" };
    }

    const matched = timingSafeEqual(computedDigest, providedDigest);
    if (!matched) {
      return { valid: false, timestamp, reason: "Signature mismatch" };
    }

    return { valid: true, timestamp };
  }

  private extractHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
    const target = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === target) {
        return Array.isArray(value) ? value[0] : value;
      }
    }
    return undefined;
  }

  /**
   * Process an incoming webhook payload with headers.
   */
  async process<T = unknown>(
    rawBody: string | Buffer,
    headers: Record<string, string | string[] | undefined> = {},
  ): Promise<WebhookProcessResult<T>> {
    const bodyStr = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
    this.stats.received++;

    const signature = this.extractHeader(headers, this.signatureHeader);
    const timestampHeader = this.extractHeader(headers, this.timestampHeader);

    try {
      if (!signature) {
        throw new WebhookVerificationError(`Missing signature header: ${this.signatureHeader}`);
      }

      const verification = this.verify(rawBody, signature, timestampHeader);
      if (!verification.valid) {
        if (verification.reason?.includes("outside tolerance")) {
          throw new WebhookTimestampError(
            verification.reason,
            verification.timestamp,
            this.toleranceSeconds,
          );
        }
        throw new WebhookVerificationError(verification.reason ?? "Invalid signature");
      }

      // Parse JSON payload
      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyStr);
      } catch (err) {
        throw new WebhookPayloadMalformedError((err as Error).message);
      }

      if (!parsed || typeof parsed !== "object") {
        throw new WebhookPayloadMalformedError("Payload must be a JSON object");
      }

      const payloadObj = parsed as Record<string, unknown>;
      const eventName =
        (payloadObj.event as string) ||
        (payloadObj.type as string) ||
        this.extractHeader(headers, this.eventHeader) ||
        "unknown";

      const normalizedPayload: WebhookEventPayload<T> = {
        id: (payloadObj.id as string) || undefined,
        event: eventName,
        invoiceId: (payloadObj.invoiceId as string) || undefined,
        timestamp: (payloadObj.timestamp as string | number) || verification.timestamp,
        data: (payloadObj.data as T) ?? (payloadObj as unknown as T),
        ...payloadObj,
      };

      // Collect handlers
      const matchedHandlers: WebhookHandler[] = [];
      const specific = this.handlers.get(eventName);
      if (specific) {
        for (const h of specific) matchedHandlers.push(h);
      }
      const wildcard = this.handlers.get("*");
      if (wildcard) {
        for (const h of wildcard) matchedHandlers.push(h);
      }

      // Collect once handlers
      const specificOnce = this.onceHandlers.get(eventName);
      if (specificOnce) {
        for (const h of specificOnce) matchedHandlers.push(h);
        this.onceHandlers.delete(eventName);
      }
      const wildcardOnce = this.onceHandlers.get("*");
      if (wildcardOnce) {
        for (const h of wildcardOnce) matchedHandlers.push(h);
        this.onceHandlers.delete("*");
      }

      // Run middleware chain then handlers, with retry on handler failure
      let index = -1;
      const dispatch = async (i: number): Promise<void> => {
        if (i <= index) throw new Error("next() called multiple times");
        index = i;
        if (i < this.middlewares.length) {
          const fn = this.middlewares[i]!;
          await fn(normalizedPayload as WebhookEventPayload, () => dispatch(i + 1));
        } else {
          // Execute all handlers
          for (const handler of matchedHandlers) {
            await handler(normalizedPayload);
          }
        }
      };

      const { retries } = await this.executeWithRetry(() => dispatch(0));

      this.stats.processed++;

      return {
        success: true,
        event: normalizedPayload,
        handlersExecuted: matchedHandlers.length,
        timestamp: verification.timestamp,
        retries,
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.stats.failed++;

      // Notify error handlers
      for (const errHandler of this.errorHandlers) {
        try {
          await errHandler(error, bodyStr, headers);
        } catch {
          // Error handler failures should not swallow initial error
        }
      }

      if (this.throwOnError) {
        throw error;
      }

      return {
        success: false,
        handlersExecuted: 0,
        error,
      };
    }
  }

  /**
   * Create an HTTP request listener compatible with Node.js http.createServer or Express.
   */
  createHttpHandler(): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
    return (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      return new Promise<void>((resolve) => {
        const chunks: Buffer[] = [];

        req.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });

        req.on("error", (err) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
          resolve();
        });

        req.on("end", async () => {
          const rawBody = Buffer.concat(chunks);
          const headers = req.headers as Record<string, string | string[] | undefined>;

          try {
            const result = await this.process(rawBody, headers);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ received: true, event: result.event?.event }));
            resolve();
          } catch (err) {
            const statusCode =
              err instanceof WebhookVerificationError ||
              err instanceof WebhookTimestampError ||
              err instanceof WebhookPayloadMalformedError
                ? 400
                : 500;
            res.writeHead(statusCode, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: (err as Error).message }));
            resolve();
          }
        });
      });
    };
  }
}
