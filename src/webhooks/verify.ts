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
 * Verifies a webhook payload against its HMAC-SHA256 signature.
 *
 * @param payload   - The raw request body / payload string.
 * @param signature - The hex-encoded HMAC-SHA256 signature to verify.
 * @param secret    - The shared secret key.
 * @returns `true` when the signature is valid, `false` otherwise.
 *          Never throws — malformed inputs return `false`.
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  if (!HEX_PATTERN.test(signature) || signature.length % 2 !== 0) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(payload).digest();
  const provided = Buffer.from(signature, "hex");

  if (expected.length !== provided.length) {
    return false;
  }

  return timingSafeEqual(expected, provided);
}

/**
 * Thrown when a webhook signature fails verification.
 *
 * Wraps {@link verifyWebhookSignature} for consumers who prefer a throwing
 * interface rather than checking a boolean return value.
 */
export class WebhookVerificationError extends Error {
  constructor() {
    super("Webhook signature verification failed");
    this.name = "WebhookVerificationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Verifies a webhook payload and throws {@link WebhookVerificationError}
 * when the signature is invalid.
 *
 * @param payload   - The raw request body / payload string.
 * @param signature - The hex-encoded HMAC-SHA256 signature to verify.
 * @param secret    - The shared secret key.
 * @throws {WebhookVerificationError} if the signature does not match.
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
