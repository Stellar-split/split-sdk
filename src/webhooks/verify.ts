/**
 * Server-side verification helper for StellarSplit webhook signatures.
 *
 * Mirrors the HMAC-SHA256 signing performed by {@link WebhookAgent} so
 * webhook consumers can confirm a payload originated from the SDK and
 * was not tampered with in transit.
 *
 * @module webhooks/verify
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const HEX_PATTERN = /^[0-9a-f]+$/i;

/**
 * Verifies an HMAC-SHA256 webhook signature using a timing-safe comparison.
 *
 * @param payload - The exact, unparsed request body (or payload string) as received.
 * @param signature - The hex-encoded HMAC signature from the request header.
 * @param secret - The shared HMAC secret configured for the webhook.
 * @returns `true` only when the computed digest matches the provided signature.
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
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
 * Error thrown when {@link verifyWebhookSignature} returns `false`,
 * indicating that the webhook payload did not originate from a trusted
 * sender or was tampered with in transit.
 */
export class WebhookVerificationError extends Error {
  constructor(message?: string) {
    super(message ?? "Webhook signature verification failed");
    this.name = "WebhookVerificationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Convenience method that wraps {@link verifyWebhookSignature} and throws
   * a {@link WebhookVerificationError} when the signature is invalid.
   *
   * @param payload - The payload string.
   * @param signature - The hex-encoded signature.
   * @param secret - The shared secret.
   * @throws {WebhookVerificationError} When the signature does not match.
   */
  static assert(payload: string, signature: string, secret: string): void {
    if (!verifyWebhookSignature(payload, signature, secret)) {
      throw new WebhookVerificationError(
        `Webhook signature verification failed for payload of length ${payload.length}`,
      );
    }
  }
}