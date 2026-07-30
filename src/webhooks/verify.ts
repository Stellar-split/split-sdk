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
 * Verifies the `X-Stellar-Split-Signature` header against the raw request
 * body using a timing-safe comparison.
 *
 * @param secret - The shared HMAC secret configured for the webhook.
 * @param rawBody - The exact, unparsed request body bytes as received.
 * @param signatureHeader - The hex-encoded signature from the request header.
 * @returns `true` only when the computed digest matches the header value.
 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string
): boolean {
  if (!HEX_PATTERN.test(signatureHeader) || signatureHeader.length % 2 !== 0) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const provided = Buffer.from(signatureHeader, "hex");

  if (expected.length !== provided.length) {
    return false;
  }

  return timingSafeEqual(expected, provided);
}
