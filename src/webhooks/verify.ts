/**
 * Server-side verification helper for StellarSplit webhook signatures.
 *
 * Mirrors the HMAC-SHA256 signing performed by {@link WebhookAgent} so
 * webhook consumers can confirm a payload originated from the SDK and
 * was not tampered with in transit.
 */

import { createHmac, timingSafeEqual } from "crypto";
import { StellarSplitError } from "../errors.js";

const HEX_PATTERN = /^[0-9a-f]+$/i;

/**
 * Error thrown when webhook signature verification fails.
 */
export class WebhookVerificationError extends StellarSplitError {
  constructor(
    message: string = "Webhook signature verification failed",
    context?: Record<string, unknown>
  ) {
    super(message, "WEBHOOK_VERIFICATION_FAILED", context);
    this.name = "WebhookVerificationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Verifies the webhook signature and throws a {@link WebhookVerificationError} if invalid.
   *
   * @param payload - The raw webhook payload string.
   * @param signature - The hex-encoded HMAC-SHA256 signature to verify.
   * @param secret - The shared secret used to generate the signature.
   * @throws {WebhookVerificationError} if verification fails.
   */
  static verify(payload: string, signature: string, secret: string): void {
    if (!verifyWebhookSignature(payload, signature, secret)) {
      throw new WebhookVerificationError();
    }
  }

  /**
   * Asserts that the webhook signature is valid, throwing {@link WebhookVerificationError} if not.
   *
   * @param payload - The raw webhook payload string.
   * @param signature - The hex-encoded HMAC-SHA256 signature to verify.
   * @param secret - The shared secret used to generate the signature.
   * @throws {WebhookVerificationError} if verification fails.
   */
  static assert(payload: string, signature: string, secret: string): void {
    if (!verifyWebhookSignature(payload, signature, secret)) {
      throw new WebhookVerificationError();
    }
  }
}

/**
 * Asserts that a webhook signature is valid against the payload and secret.
 * Throws a {@link WebhookVerificationError} if the signature is invalid.
 *
 * @param payload - The raw webhook payload string.
 * @param signature - The hex-encoded HMAC-SHA256 signature to verify.
 * @param secret - The shared secret used to generate the signature.
 * @throws {WebhookVerificationError} if signature verification fails.
 */
export function assertWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): void {
  if (!verifyWebhookSignature(payload, signature, secret)) {
    throw new WebhookVerificationError();
  }
}

/**
 * Verifies a webhook signature against the raw payload using HMAC-SHA256 and
 * constant-time comparison to prevent timing attacks.
 *
 * @param payload - The raw request payload string as received.
 * @param signature - The hex-encoded signature from the request header.
 * @param secret - The shared HMAC secret configured for the webhook.
 * @returns `true` if the computed HMAC matches the provided signature, `false` otherwise (never throws).
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  try {
    if (
      typeof payload !== "string" ||
      typeof signature !== "string" ||
      typeof secret !== "string"
    ) {
      return false;
    }

    const trimmedSignature = signature.trim();
    if (!HEX_PATTERN.test(trimmedSignature) || trimmedSignature.length % 2 !== 0) {
      return false;
    }

    const expectedHex = createHmac("sha256", secret).update(payload).digest("hex");
    const expectedBuf = Buffer.from(expectedHex, "hex");
    const providedBuf = Buffer.from(trimmedSignature, "hex");

    if (expectedBuf.length !== providedBuf.length) {
      return false;
    }

    return timingSafeEqual(expectedBuf, providedBuf);
  } catch {
    return false;
  }
}
