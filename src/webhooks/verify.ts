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
 * Error thrown by {@link WebhookVerificationError} when a signature cannot
 * be verified. Consumers who prefer throwing over boolean returns can catch
 * this error instead of checking the return value of
 * {@link verifyWebhookSignature}.
 */
export class WebhookVerificationError extends Error {
  public readonly name = "WebhookVerificationError";

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, WebhookVerificationError.prototype);
  }
}

/**
 * Verifies an HMAC-SHA256 webhook signature against a payload using a
 * timing-safe comparison.
 *
 * @param payload - The raw payload string to verify.
 * @param signature - The hex-encoded signature to check against.
 * @param secret - The shared HMAC secret configured for the webhook.
 * @returns `true` when the computed digest matches the signature,
 *   `false` when the signature is malformed, lengths differ, or the digest
 *   does not match. Never throws.
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
 * Verifies an HMAC-SHA256 webhook signature and throws if it does not match.
 *
 * @param payload - The raw payload string to verify.
 * @param signature - The hex-encoded signature to check against.
 * @param secret - The shared HMAC secret configured for the webhook.
 * @throws {WebhookVerificationError} If the signature is invalid.
 * @returns `true` when the signature is valid.
 */
export function verifyWebhookSignatureOrThrow(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  if (!verifyWebhookSignature(payload, signature, secret)) {
    throw new WebhookVerificationError("Invalid webhook signature");
  }
  return true;
}
