/**
 * Server-side verification helper for StellarSplit webhook signatures.
 *
 * Mirrors the HMAC-SHA256 signing performed by {@link WebhookAgent} so
 * webhook consumers can confirm a payload originated from the SDK and
 * was not tampered with in transit.
 */

import { createHmac, timingSafeEqual } from "crypto";

const HEX_PATTERN = /^[0-9a-f]+$/i;

/**
 * Error thrown when webhook signature verification fails in throwing assertion mode.
 */
export class WebhookVerificationError extends Error {
  constructor(message = "Webhook signature verification failed") {
    super(message);
    this.name = "WebhookVerificationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Verifies a webhook signature against the raw payload and shared secret using HMAC-SHA256
 * and constant-time buffer comparison (`crypto.timingSafeEqual`) to prevent timing attacks.
 *
 * Supports both `(payload, signature, secret)` and `(secret, rawBody, signatureHeader)` calling conventions.
 * Never throws on malformed signature or payload; returns `false` instead.
 *
 * @param payloadOrSecret - Raw body string or secret string
 * @param signatureOrRawBody - Hex signature string or raw body string
 * @param secretOrSignature - Secret string or hex signature string
 * @returns `true` only when the computed HMAC-SHA256 digest matches the signature.
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean;
export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string
): boolean;
export function verifyWebhookSignature(
  arg1: string,
  arg2: string,
  arg3: string
): boolean {
  if (
    typeof arg1 !== "string" ||
    typeof arg2 !== "string" ||
    typeof arg3 !== "string"
  ) {
    return false;
  }

  // Attempt 1: (payload: arg1, signature: arg2, secret: arg3)
  const cleanSig1 = arg2.trim();
  if (HEX_PATTERN.test(cleanSig1) && cleanSig1.length % 2 === 0) {
    try {
      const expected1 = createHmac("sha256", arg3).update(arg1).digest();
      const provided1 = Buffer.from(cleanSig1, "hex");
      if (expected1.length === provided1.length && timingSafeEqual(expected1, provided1)) {
        return true;
      }
    } catch {
      // Continue to attempt 2
    }
  }

  // Attempt 2: (secret: arg1, rawBody: arg2, signatureHeader: arg3)
  const cleanSig2 = arg3.trim();
  if (HEX_PATTERN.test(cleanSig2) && cleanSig2.length % 2 === 0) {
    try {
      const expected2 = createHmac("sha256", arg1).update(arg2).digest();
      const provided2 = Buffer.from(cleanSig2, "hex");
      if (expected2.length === provided2.length && timingSafeEqual(expected2, provided2)) {
        return true;
      }
    } catch {
      // Return false
    }
  }

  return false;
}

/**
 * Asserts that a webhook signature is valid, throwing {@link WebhookVerificationError} if it is not.
 *
 * @param payload - Raw payload string.
 * @param signature - Hex signature string.
 * @param secret - Shared HMAC secret.
 * @throws {WebhookVerificationError} if signature verification returns `false`.
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

