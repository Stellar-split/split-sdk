import { createHmac, timingSafeEqual } from 'crypto';

export type WebhookSignatureAlgorithm = 'sha256' | 'sha1' | 'sha512';

export interface WebhookSignatureConfig {
  /** Shared secret used to compute the HMAC signature. */
  secret: string;
  /** Hash algorithm to use. Defaults to 'sha256'. */
  algorithm?: WebhookSignatureAlgorithm;
  /** Header name carrying the signature. Defaults to 'x-webhook-signature'. */
  signatureHeader?: string;
  /** Optional prefix on the signature value, e.g. 'sha256='. */
  signaturePrefix?: string;
  /** Allowed clock skew in seconds for timestamped signatures. Defaults to 300. */
  toleranceSeconds?: number;
}

export interface WebhookSignaturePayload {
  /** Raw request body exactly as received (string or Buffer). */
  body: string | Buffer;
  /** Signature value from the request header. */
  signature: string;
  /** Optional timestamp (seconds or ms) included in the signed payload. */
  timestamp?: number | string;
}

export interface WebhookVerificationResult {
  valid: boolean;
  reason?: string;
}

export type WebhookEventHandler = (event: WebhookEvent) => void;

export interface WebhookEvent {
  type: 'webhook.validated' | 'webhook.rejected';
  timestamp: number;
  reason?: string;
}

const DEFAULT_ALGORITHM: WebhookSignatureAlgorithm = 'sha256';
const DEFAULT_SIGNATURE_HEADER = 'x-webhook-signature';
const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Computes an HMAC signature for the given payload.
 */
export function computeSignature(
  payload: string | Buffer,
  secret: string,
  algorithm: WebhookSignatureAlgorithm = DEFAULT_ALGORITHM,
): string {
  return createHmac(algorithm, secret).update(payload).digest('hex');
}

/**
 * Constant-time comparison of two hex signatures.
 */
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Builds the canonical string that gets signed, optionally including a timestamp.
 */
export function buildSignedPayload(
  body: string | Buffer,
  timestamp?: number | string,
): string | Buffer {
  if (timestamp === undefined) {
    return body;
  }
  const bodyStr = Buffer.isBuffer(body) ? body.toString('utf8') : body;
  return `${timestamp}.${bodyStr}`;
}

/**
 * Webhook signature validator with event handling for validated/rejected webhooks.
 */
export class WebhookSignatureValidator {
  private readonly secret: string;
  private readonly algorithm: WebhookSignatureAlgorithm;
  private readonly signatureHeader: string;
  private readonly signaturePrefix: string;
  private readonly toleranceSeconds: number;
  private readonly handlers: Set<WebhookEventHandler> = new Set();

  constructor(config: WebhookSignatureConfig) {
    if (!config || typeof config.secret !== 'string' || config.secret.length === 0) {
      throw new Error('WebhookSignatureValidator requires a non-empty secret');
    }
    this.secret = config.secret;
    this.algorithm = config.algorithm ?? DEFAULT_ALGORITHM;
    this.signatureHeader = config.signatureHeader ?? DEFAULT_SIGNATURE_HEADER;
    this.signaturePrefix = config.signaturePrefix ?? '';
    this.toleranceSeconds = config.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  }

  /** Header name carrying the signature. */
  get headerName(): string {
    return this.signatureHeader;
  }

  /** Registers an event handler. Returns an unsubscribe function. */
  on(handler: WebhookEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** Removes a previously registered handler. */
  off(handler: WebhookEventHandler): void {
    this.handlers.delete(handler);
  }

  private emit(event: WebhookEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // Handler errors must not break verification flow.
      }
    }
  }

  /**
   * Verifies a webhook payload against its signature.
   */
  verify(payload: WebhookSignaturePayload): WebhookVerificationResult {
    const result = this.check(payload);
    this.emit({
      type: result.valid ? 'webhook.validated' : 'webhook.rejected',
      timestamp: Date.now(),
      reason: result.reason,
    });
    return result;
  }

  private check(payload: WebhookSignaturePayload): WebhookVerificationResult {
    if (!payload || typeof payload.signature !== 'string' || payload.signature.length === 0) {
      return { valid: false, reason: 'missing signature' };
    }

    if (payload.timestamp !== undefined && !this.isTimestampFresh(payload.timestamp)) {
      return { valid: false, reason: 'timestamp outside tolerance' };
    }

    const provided = this.stripPrefix(payload.signature);
    const signed = buildSignedPayload(payload.body, payload.timestamp);
    const expected = computeSignature(signed, this.secret, this.algorithm);

    if (!safeCompare(expected, provided)) {
      return { valid: false, reason: 'signature mismatch' };
    }

    return { valid: true };
  }

  private stripPrefix(signature: string): string {
    if (this.signaturePrefix && signature.startsWith(this.signaturePrefix)) {
      return signature.slice(this.signaturePrefix.length);
    }
    return signature;
  }

  private isTimestampFresh(timestamp: number | string): boolean {
    const value = typeof timestamp === 'string' ? Number(timestamp) : timestamp;
    if (!Number.isFinite(value)) {
      return false;
    }
    // Accept both seconds and milliseconds.
    const ms = value > 1e12 ? value : value * 1000;
    const skew = Math.abs(Date.now() - ms) / 1000;
    return skew <= this.toleranceSeconds;
  }
}

/**
 * Convenience helper for one-off verification without constructing a validator.
 */
export function verifyWebhookSignature(
  payload: WebhookSignaturePayload,
  config: WebhookSignatureConfig,
): WebhookVerificationResult {
  return new WebhookSignatureValidator(config).verify(payload);
}

/**
 * Alias for verifyWebhookSignature, provided for API convenience.
 */
export function validateWebhook(
  payload: WebhookSignaturePayload,
  config: WebhookSignatureConfig,
): WebhookVerificationResult {
  return verifyWebhookSignature(payload, config);
}
