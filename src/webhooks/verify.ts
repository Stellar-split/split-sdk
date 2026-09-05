/**
 * Server-side verification helper for StellarSplit webhook signatures.
 *
 * Mirrors the HMAC-SHA256 signing performed by {@link WebhookAgent} so
 * webhook consumers can confirm a payload originated from the SDK and
 * was not tampered with in transit.
 */

import { createHmac, timingSafeEqual } from "crypto";

const HEX_PATTERN = /^[0-9a-f]+$/i;

/** Thrown by {@link verifyWebhookSignatureOrThrow} when the signature does not match. */
export class WebhookVerificationError extends Error {
  constructor(message = "Webhook signature verification failed") {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

/**
 * Verifies an HMAC-SHA256 webhook signature in constant time.
 *
 * @param payload - The raw request body (exact bytes as received).
 * @param signature - The hex-encoded signature to verify against.
 * @param secret - The shared HMAC secret.
 * @returns `true` when the computed digest matches the provided signature.
 *          Returns `false` (never throws) on malformed input or mismatch.
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  if (!HEX_PATTERN.test(signature)) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf-8");
  const providedBuf = Buffer.from(signature, "utf-8");

  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }

  return timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * Wrapper around {@link verifyWebhookSignature} that throws
 * {@link WebhookVerificationError} instead of returning `false`.
 */
export function verifyWebhookSignatureOrThrow(
  payload: string,
  signature: string,
  secret: string
): void {
  if (!verifyWebhookSignature(payload, signature, secret)) {
    throw new WebhookVerificationError();
  }
}
