import { ValidationError } from "./errors.js";
import { createHmac, timingSafeEqual } from "crypto";

const textEncoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link validateWebhook} when the request's HMAC-SHA256 signature
 * does not match the computed signature.
 */
export class WebhookSignatureError extends Error {
  constructor(message = "Webhook signature verification failed") {
    super(message);
    this.name = "WebhookSignatureError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizeHex(hex: string): string {
  return hex.toLowerCase();
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = normalizeHex(hex);
  if (normalized.length % 2 !== 0) {
    throw new ValidationError("Invalid hex string length", { hexLength: normalized.length });
  }

  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeCompare(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    diff |= ai ^ bi;
  }

  return diff === 0;
}

async function computeHmacSha256(secret: string, message: string): Promise<Uint8Array> {
  if (typeof globalThis.crypto !== "undefined" && "subtle" in globalThis.crypto) {
    const key = await globalThis.crypto.subtle.importKey(
      "raw",
      textEncoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const signature = await globalThis.crypto.subtle.sign(
      "HMAC",
      key,
      textEncoder.encode(message)
    );

    return new Uint8Array(signature);
  }

  const digest = createHmac("sha256", secret).update(message).digest();
  return new Uint8Array(digest);
}

// ---------------------------------------------------------------------------
// Original export — validates a pre-serialised hex signature
// ---------------------------------------------------------------------------

export async function validateWebhookSignature(
  payload: unknown,
  signature: string,
  secret: string
): Promise<boolean> {
  const payloadJson = JSON.stringify(payload);
  if (payloadJson === undefined) {
    return false;
  }

  let expectedBytes: Uint8Array;
  try {
    expectedBytes = await computeHmacSha256(secret, payloadJson);
  } catch {
    return false;
  }

  let providedBytes: Uint8Array;
  try {
    providedBytes = hexToBytes(signature);
  } catch {
    return false;
  }

  return constantTimeCompare(expectedBytes, providedBytes);
}

// ---------------------------------------------------------------------------
// New export — validates X-Split-Signature header against the raw request body
// ---------------------------------------------------------------------------

/**
 * Expected signature header format produced by Stellar-split webhook
 * deliveries: `hmac-sha256=<hex-digest>`.
 */
const SIGNATURE_PREFIX = "hmac-sha256=";

/**
 * Verify the HMAC-SHA256 signature attached to a webhook delivery.
 *
 * The signature is expected in the `X-Split-Signature` header using the
 * format `hmac-sha256=<hex-digest>`.  The HMAC is computed over the raw
 * request body (bytes) so that JSON key ordering is preserved exactly as
 * the sender signed it.
 *
 * Pass `secret = null` to skip verification entirely (opt-out mode).
 *
 * @param payload   - Parsed request body (used only for type-checking; the
 *                    HMAC is verified against `rawBody`).
 * @param rawBody   - The verbatim request body bytes / string received over
 *                    the wire.  Must match what the sender signed.
 * @param secret    - Shared HMAC secret.  Pass `null` to skip verification.
 * @param signature - Value of the `X-Split-Signature` header.
 *
 * @throws {WebhookSignatureError} When the computed HMAC does not match the
 *   provided signature.
 */
export function validateWebhook(
  payload: unknown,
  rawBody: string | Uint8Array,
  secret: string | null,
  signature: string
): void {
  // Opt-out: skip verification when secret is explicitly null.
  if (secret === null) {
    return;
  }

  // Strip the "hmac-sha256=" prefix if present.
  const hexDigest = signature.startsWith(SIGNATURE_PREFIX)
    ? signature.slice(SIGNATURE_PREFIX.length)
    : signature;

  const body =
    rawBody instanceof Uint8Array
      ? rawBody
      : Buffer.from(rawBody, "utf8");

  const expected = createHmac("sha256", secret).update(body).digest();

  let provided: Buffer;
  try {
    provided = Buffer.from(hexDigest, "hex");
  } catch {
    throw new WebhookSignatureError("Webhook signature header is not valid hex");
  }

  if (provided.length === 0) {
    throw new WebhookSignatureError("Webhook signature header is empty or not valid hex");
  }

  // Use Node.js timingSafeEqual to prevent timing attacks.
  const match =
    expected.length === provided.length &&
    timingSafeEqual(expected, provided);

  if (!match) {
    throw new WebhookSignatureError();
  }
}
