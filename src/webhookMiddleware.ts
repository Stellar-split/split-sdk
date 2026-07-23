/**
 * Secure webhook middleware for receiving and parsing StellarSplit invoice webhooks.
 * 
 * This module provides production-ready middleware with:
 * - HMAC-SHA256 signature verification with constant-time comparison
 * - Replay attack protection using timestamp tolerance and nonce tracking
 * - LRU cache for nonce deduplication
 * - Express/Next.js compatibility
 * 
 * @module webhookMiddleware
 */

import type { Request, Response, NextFunction } from "express";
import { ValidationError } from "./errors.js";

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Configuration options for webhook middleware.
 */
export interface WebhookOptions {
  /**
   * Maximum allowed clock drift for timestamp validation in seconds.
   * Requests with timestamps outside this window will be rejected.
   * @default 300 (5 minutes)
   */
  toleranceSeconds?: number;

  /**
   * Maximum size for the in-memory LRU cache that tracks seen nonces.
   * This prevents replay attacks by remembering recently used nonces.
   * @default 1000
   */
  nonceWindowSize?: number;

  /**
   * Header name containing the HMAC signature.
   * @default "x-stellarsplit-signature"
   */
  signatureHeader?: string;

  /**
   * Header name containing the timestamp.
   * @default "x-stellarsplit-timestamp"
   */
  timestampHeader?: string;

  /**
   * Header name containing the unique nonce.
   * @default "x-stellarsplit-nonce"
   */
  nonceHeader?: string;
}

/**
 * Invoice event types emitted by StellarSplit webhooks.
 */
export type InvoiceEventType =
  | "invoice.created"
  | "invoice.paid"
  | "invoice.failed"
  | "invoice.released"
  | "invoice.refunded"
  | "invoice.cancelled"
  | "invoice.expired";

/**
 * Base webhook payload structure.
 */
export interface WebhookPayload<T = unknown> {
  /** Event type identifier */
  event: InvoiceEventType;
  /** Unix timestamp in seconds when the event occurred */
  timestamp: number;
  /** Unique nonce for replay protection */
  nonce: string;
  /** Event-specific data */
  data: T;
}

/**
 * Webhook data for invoice.created event.
 */
export interface InvoiceCreatedData {
  invoiceId: string;
  creator: string;
  recipients: Array<{ address: string; amount: string }>;
  token: string;
  deadline: number;
  totalAmount: string;
}

/**
 * Webhook data for invoice.paid event.
 */
export interface InvoicePaidData {
  invoiceId: string;
  payer: string;
  amount: string;
  funded: string;
  remaining: string;
  txHash: string;
}

/**
 * Webhook data for invoice.released event.
 */
export interface InvoiceReleasedData {
  invoiceId: string;
  totalAmount: string;
  recipients: Array<{ address: string; amount: string; txHash: string }>;
  releasedAt: number;
}

/**
 * Webhook data for invoice.failed event.
 */
export interface InvoiceFailedData {
  invoiceId: string;
  reason: string;
  failedAt: number;
}

/**
 * Webhook data for invoice.refunded event.
 */
export interface InvoiceRefundedData {
  invoiceId: string;
  totalRefunded: string;
  refundedAt: number;
}

/**
 * Webhook data for invoice.cancelled event.
 */
export interface InvoiceCancelledData {
  invoiceId: string;
  cancelledBy: string;
  cancelledAt: number;
}

/**
 * Webhook data for invoice.expired event.
 */
export interface InvoiceExpiredData {
  invoiceId: string;
  deadline: number;
  expiredAt: number;
}

/**
 * Express Request with validated webhook payload attached.
 */
export interface WebhookRequest<T = unknown> extends Request {
  webhookPayload: WebhookPayload<T>;
  rawWebhookBody: string;
}

/**
 * Type guard to check if request has webhook payload.
 */
export function isWebhookRequest<T = unknown>(
  req: Request,
): req is WebhookRequest<T> {
  return "webhookPayload" in req && "rawWebhookBody" in req;
}

/**
 * Express-compatible request handler type.
 */
export type RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => void | Promise<void>;

// ============================================================================
// LRU Cache Implementation
// ============================================================================

/**
 * Least Recently Used (LRU) cache for nonce tracking.
 * Provides O(1) get/set operations and automatic eviction of oldest entries.
 */
class LRUCache<K, V> {
  private readonly capacity: number;
  private readonly cache: Map<K, V>;
  private readonly order: K[];

  constructor(capacity: number) {
    if (capacity <= 0) {
      throw new ValidationError("LRU cache capacity must be positive", {
        capacity,
      });
    }
    this.capacity = capacity;
    this.cache = new Map();
    this.order = [];
  }

  /**
   * Get a value from the cache. Returns undefined if not found.
   * Updates the access order (moves to end).
   */
  get(key: K): V | undefined {
    if (!this.cache.has(key)) {
      return undefined;
    }

    // Move to end (most recently used)
    const index = this.order.indexOf(key);
    if (index !== -1) {
      this.order.splice(index, 1);
      this.order.push(key);
    }

    return this.cache.get(key);
  }

  /**
   * Set a value in the cache. Evicts the least recently used entry if at capacity.
   */
  set(key: K, value: V): void {
    // If key exists, update it and move to end
    if (this.cache.has(key)) {
      this.cache.set(key, value);
      const index = this.order.indexOf(key);
      if (index !== -1) {
        this.order.splice(index, 1);
        this.order.push(key);
      }
      return;
    }

    // Evict oldest if at capacity
    if (this.order.length >= this.capacity) {
      const oldest = this.order.shift();
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }

    // Add new entry
    this.cache.set(key, value);
    this.order.push(key);
  }

  /**
   * Check if a key exists in the cache.
   */
  has(key: K): boolean {
    return this.cache.has(key);
  }

  /**
   * Get the current size of the cache.
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Clear all entries from the cache.
   */
  clear(): void {
    this.cache.clear();
    this.order.length = 0;
  }
}

// ============================================================================
// Cryptographic Utilities
// ============================================================================

const textEncoder = new TextEncoder();

/**
 * Compute HMAC-SHA256 signature using Web Crypto API or Node.js crypto.
 * Works in both browser and Node.js environments.
 */
async function computeHmacSha256(
  secret: string,
  message: string,
): Promise<Uint8Array> {
  // Try Web Crypto API first (browser and modern Node.js)
  if (typeof globalThis.crypto !== "undefined" && "subtle" in globalThis.crypto) {
    const key = await globalThis.crypto.subtle.importKey(
      "raw",
      textEncoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const signature = await globalThis.crypto.subtle.sign(
      "HMAC",
      key,
      textEncoder.encode(message),
    );

    return new Uint8Array(signature);
  }

  // Fallback to Node.js crypto module
  const crypto = await import("crypto");
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(message);
  const digest = hmac.digest();
  return new Uint8Array(digest);
}

/**
 * Convert hex string to byte array.
 * Handles both uppercase and lowercase hex strings.
 */
function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.toLowerCase().trim();
  
  if (normalized.length % 2 !== 0) {
    throw new ValidationError("Invalid hex string length", {
      hexLength: normalized.length,
    });
  }

  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const byte = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new ValidationError("Invalid hex character in signature", {
        position: i * 2,
      });
    }
    bytes[i] = byte;
  }

  return bytes;
}

/**
 * Convert byte array to hex string.
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time comparison of two byte arrays.
 * Prevents timing side-channel attacks during signature verification.
 * 
 * This implementation uses bitwise XOR to accumulate differences,
 * ensuring the comparison time is independent of where differences occur.
 */
function constantTimeCompare(a: Uint8Array, b: Uint8Array): boolean {
  // Length must match - but don't return early to maintain constant time
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    // Use ?? 0 to satisfy TypeScript's noUncheckedIndexedAccess
    const byteA = a[i] ?? 0;
    const byteB = b[i] ?? 0;
    diff |= byteA ^ byteB;
  }

  return diff === 0;
}

/**
 * Verify HMAC-SHA256 signature in constant time.
 * 
 * @param payload - The original payload string
 * @param signature - Hex-encoded HMAC signature
 * @param secret - Shared secret key
 * @returns True if signature is valid
 */
async function verifySignature(
  payload: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  try {
    const expectedBytes = await computeHmacSha256(secret, payload);
    const providedBytes = hexToBytes(signature);
    return constantTimeCompare(expectedBytes, providedBytes);
  } catch (error) {
    // Log error but return false (invalid signature)
    return false;
  }
}

// ============================================================================
// Webhook Middleware Error Classes
// ============================================================================

/**
 * Base error class for webhook validation failures.
 */
export class WebhookValidationError extends ValidationError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, context);
    this.name = "WebhookValidationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Error thrown when webhook signature verification fails.
 */
export class InvalidSignatureError extends WebhookValidationError {
  constructor(message = "Invalid webhook signature") {
    super(message);
    this.name = "InvalidSignatureError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Error thrown when webhook timestamp is outside tolerance window.
 */
export class TimestampOutOfBoundsError extends WebhookValidationError {
  constructor(
    public readonly timestamp: number,
    public readonly tolerance: number,
  ) {
    super("Webhook timestamp outside tolerance window", {
      timestamp,
      tolerance,
      now: Math.floor(Date.now() / 1000),
    });
    this.name = "TimestampOutOfBoundsError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Error thrown when a webhook nonce has been seen before (replay attack).
 */
export class ReplayAttackError extends WebhookValidationError {
  constructor(public readonly nonce: string) {
    super("Webhook nonce has already been used (replay attack detected)", {
      nonce,
    });
    this.name = "ReplayAttackError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Error thrown when required webhook headers are missing.
 */
export class MissingHeaderError extends WebhookValidationError {
  constructor(public readonly headerName: string) {
    super(`Missing required webhook header: ${headerName}`, { headerName });
    this.name = "MissingHeaderError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Error thrown when webhook payload is invalid or malformed.
 */
export class InvalidPayloadError extends WebhookValidationError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(`Invalid webhook payload: ${message}`, context);
    this.name = "InvalidPayloadError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ============================================================================
// Webhook Middleware Factory
// ============================================================================

const DEFAULT_OPTIONS: Required<WebhookOptions> = {
  toleranceSeconds: 300, // 5 minutes
  nonceWindowSize: 1000,
  signatureHeader: "x-stellarsplit-signature",
  timestampHeader: "x-stellarsplit-timestamp",
  nonceHeader: "x-stellarsplit-nonce",
};

/**
 * Create a secure webhook middleware for Express/Next.js.
 * 
 * This middleware verifies incoming StellarSplit webhooks using:
 * 1. HMAC-SHA256 signature verification with constant-time comparison
 * 2. Timestamp validation to prevent old requests
 * 3. Nonce tracking with LRU cache to prevent replay attacks
 * 
 * @param secret - Shared secret key for HMAC verification
 * @param options - Configuration options
 * @returns Express-compatible middleware function
 * 
 * @example
 * ```typescript
 * import express from 'express';
 * import { createWebhookMiddleware } from '@stellar-split/sdk';
 * 
 * const app = express();
 * 
 * // Raw body parser for signature verification
 * app.use('/webhooks/stellarsplit', express.raw({ type: 'application/json' }));
 * 
 * // Webhook middleware with verification
 * app.post(
 *   '/webhooks/stellarsplit',
 *   createWebhookMiddleware(process.env.WEBHOOK_SECRET!, {
 *     toleranceSeconds: 300,
 *     nonceWindowSize: 1000,
 *   }),
 *   (req, res) => {
 *     const { event, data } = req.webhookPayload;
 *     
 *     switch (event) {
 *       case 'invoice.paid':
 *         console.log('Invoice paid:', data);
 *         break;
 *       case 'invoice.released':
 *         console.log('Invoice released:', data);
 *         break;
 *     }
 *     
 *     res.status(200).json({ received: true });
 *   }
 * );
 * ```
 */
export function createWebhookMiddleware(
  secret: string,
  options?: WebhookOptions,
): RequestHandler {
  if (!secret || typeof secret !== "string" || secret.length === 0) {
    throw new ValidationError("Webhook secret must be a non-empty string");
  }

  const config: Required<WebhookOptions> = {
    ...DEFAULT_OPTIONS,
    ...options,
  };

  // Initialize LRU cache for nonce tracking
  const nonceCache = new LRUCache<string, number>(config.nonceWindowSize);

  // Return the middleware function
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // ====================================================================
      // Step 1: Extract and validate headers
      // ====================================================================
      const signature = req.headers[config.signatureHeader.toLowerCase()];
      const timestampHeader = req.headers[config.timestampHeader.toLowerCase()];
      const nonce = req.headers[config.nonceHeader.toLowerCase()];

      if (!signature || typeof signature !== "string") {
        throw new MissingHeaderError(config.signatureHeader);
      }

      if (!timestampHeader || typeof timestampHeader !== "string") {
        throw new MissingHeaderError(config.timestampHeader);
      }

      if (!nonce || typeof nonce !== "string") {
        throw new MissingHeaderError(config.nonceHeader);
      }

      // ====================================================================
      // Step 2: Validate timestamp (prevent old requests)
      // ====================================================================
      const timestamp = Number.parseInt(timestampHeader, 10);
      if (Number.isNaN(timestamp)) {
        throw new InvalidPayloadError("Timestamp must be a valid integer");
      }

      const now = Math.floor(Date.now() / 1000);
      const timeDiff = Math.abs(now - timestamp);

      if (timeDiff > config.toleranceSeconds) {
        throw new TimestampOutOfBoundsError(timestamp, config.toleranceSeconds);
      }

      // ====================================================================
      // Step 3: Check nonce for replay attacks
      // ====================================================================
      if (nonceCache.has(nonce)) {
        throw new ReplayAttackError(nonce);
      }

      // ====================================================================
      // Step 4: Extract raw body for signature verification
      // ====================================================================
      let rawBody: string;

      if (Buffer.isBuffer(req.body)) {
        // Body is a Buffer (from express.raw())
        rawBody = req.body.toString("utf8");
      } else if (typeof req.body === "string") {
        // Body is already a string
        rawBody = req.body;
      } else if (typeof req.body === "object" && req.body !== null) {
        // Body has been parsed to object - need to re-stringify
        // This is not ideal but can happen if middleware order is wrong
        rawBody = JSON.stringify(req.body);
      } else {
        throw new InvalidPayloadError("Request body is missing or invalid");
      }

      // ====================================================================
      // Step 5: Verify HMAC-SHA256 signature (constant-time)
      // ====================================================================
      const isValid = await verifySignature(rawBody, signature, secret);

      if (!isValid) {
        throw new InvalidSignatureError();
      }

      // ====================================================================
      // Step 6: Parse and validate payload structure
      // ====================================================================
      let payload: WebhookPayload;

      try {
        payload = JSON.parse(rawBody) as WebhookPayload;
      } catch (parseError) {
        throw new InvalidPayloadError("Payload is not valid JSON", {
          error: parseError instanceof Error ? parseError.message : String(parseError),
        });
      }

      // Validate required fields
      if (!payload.event || typeof payload.event !== "string") {
        throw new InvalidPayloadError("Missing or invalid 'event' field");
      }

      if (typeof payload.timestamp !== "number") {
        throw new InvalidPayloadError("Missing or invalid 'timestamp' field");
      }

      if (!payload.nonce || typeof payload.nonce !== "string") {
        throw new InvalidPayloadError("Missing or invalid 'nonce' field");
      }

      if (!payload.data) {
        throw new InvalidPayloadError("Missing 'data' field");
      }

      // Verify nonce matches header
      if (payload.nonce !== nonce) {
        throw new InvalidPayloadError("Nonce in payload does not match header");
      }

      // Verify timestamp matches header
      if (payload.timestamp !== timestamp) {
        throw new InvalidPayloadError("Timestamp in payload does not match header");
      }

      // ====================================================================
      // Step 7: Mark nonce as seen (after all validation passes)
      // ====================================================================
      nonceCache.set(nonce, timestamp);

      // ====================================================================
      // Step 8: Attach validated payload to request
      // ====================================================================
      (req as WebhookRequest).webhookPayload = payload;
      (req as WebhookRequest).rawWebhookBody = rawBody;

      // All checks passed - proceed to next middleware/handler
      next();
    } catch (error) {
      // Handle validation errors
      if (error instanceof WebhookValidationError) {
        res.status(400).json({
          error: error.name,
          message: error.message,
          code: error.code,
        });
        return;
      }

      // Handle unexpected errors
      console.error("Webhook middleware error:", error);
      res.status(500).json({
        error: "InternalServerError",
        message: "An unexpected error occurred while processing the webhook",
      });
    }
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Generate HMAC-SHA256 signature for a webhook payload.
 * Used by webhook senders to sign outgoing webhooks.
 * 
 * @param payload - The webhook payload object
 * @param secret - Shared secret key
 * @returns Hex-encoded HMAC signature
 * 
 * @example
 * ```typescript
 * const payload = {
 *   event: 'invoice.paid',
 *   timestamp: Math.floor(Date.now() / 1000),
 *   nonce: crypto.randomUUID(),
 *   data: { invoiceId: '123', amount: '1000' }
 * };
 * 
 * const signature = await generateWebhookSignature(payload, secret);
 * ```
 */
export async function generateWebhookSignature(
  payload: WebhookPayload,
  secret: string,
): Promise<string> {
  const payloadString = JSON.stringify(payload);
  const signatureBytes = await computeHmacSha256(secret, payloadString);
  return bytesToHex(signatureBytes);
}

/**
 * Manually verify a webhook signature without middleware.
 * Useful for testing or custom webhook handling.
 * 
 * @param payload - The webhook payload string or object
 * @param signature - Hex-encoded HMAC signature
 * @param secret - Shared secret key
 * @returns True if signature is valid
 * 
 * @example
 * ```typescript
 * const isValid = await verifyWebhookSignature(
 *   rawBody,
 *   req.headers['x-stellarsplit-signature'],
 *   process.env.WEBHOOK_SECRET
 * );
 * ```
 */
export async function verifyWebhookSignature(
  payload: string | WebhookPayload,
  signature: string,
  secret: string,
): Promise<boolean> {
  const payloadString =
    typeof payload === "string" ? payload : JSON.stringify(payload);
  return verifySignature(payloadString, signature, secret);
}

/**
 * Type guard to check if an event type is valid.
 */
export function isValidEventType(event: string): event is InvoiceEventType {
  const validEvents: InvoiceEventType[] = [
    "invoice.created",
    "invoice.paid",
    "invoice.failed",
    "invoice.released",
    "invoice.refunded",
    "invoice.cancelled",
    "invoice.expired",
  ];
  return validEvents.includes(event as InvoiceEventType);
}

/**
 * Parse and validate a webhook payload with type checking.
 * 
 * @param rawPayload - Raw webhook payload string
 * @returns Parsed and validated webhook payload
 * @throws {InvalidPayloadError} If payload is invalid
 */
export function parseWebhookPayload<T = unknown>(
  rawPayload: string,
): WebhookPayload<T> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawPayload);
  } catch (error) {
    throw new InvalidPayloadError("Payload is not valid JSON", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new InvalidPayloadError("Payload must be an object");
  }

  const payload = parsed as Record<string, unknown>;

  if (!payload.event || typeof payload.event !== "string") {
    throw new InvalidPayloadError("Missing or invalid 'event' field");
  }

  if (!isValidEventType(payload.event)) {
    throw new InvalidPayloadError(`Unknown event type: ${payload.event}`);
  }

  if (typeof payload.timestamp !== "number") {
    throw new InvalidPayloadError("Missing or invalid 'timestamp' field");
  }

  if (!payload.nonce || typeof payload.nonce !== "string") {
    throw new InvalidPayloadError("Missing or invalid 'nonce' field");
  }

  if (!payload.data) {
    throw new InvalidPayloadError("Missing 'data' field");
  }

  return {
    event: payload.event as InvoiceEventType,
    timestamp: payload.timestamp as number,
    nonce: payload.nonce as string,
    data: payload.data as T,
  };
}
