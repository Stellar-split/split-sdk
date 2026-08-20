/**
 * Test suite for the standalone webhook signature verification module
 * (Issue #617: Export verifyWebhookSignature as standalone function).
 *
 * Covers:
 * - Valid signature returns true
 * - Wrong secret returns false
 * - Tampered payload returns false
 * - Mismatched length returns false without throwing
 * - Malformed (non-hex) signature returns false without throwing
 * - WebhookVerificationError wrapping behavior
 * - Index re-exports
 *
 * @vitest-environment node
 */

import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  verifyWebhookSignature,
  WebhookVerificationError,
} from "../src/webhooks/verify.js";
import {
  verifyWebhookSignature as verifyFromIndex,
  WebhookVerificationError as VerificationErrorFromIndex,
} from "../src/index.js";

const TEST_SECRET = "test_secret_key_12345";

/** Compute a valid HMAC-SHA256 hex signature using Web Crypto API (works in jsdom). */
async function sign(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload),
  );
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("verifyWebhookSignature (src/webhooks/verify.ts)", () => {
  it("returns true for a valid signature", async () => {
    const payload = '{"event":"invoice.paid","data":{"invoiceId":"123"}}';
    const signature = await sign(payload, TEST_SECRET);

    expect(verifyWebhookSignature(payload, signature, TEST_SECRET)).toBe(true);
  });

  it("returns false for a wrong secret", async () => {
    const payload = '{"event":"invoice.paid","data":{"invoiceId":"123"}}';
    const signature = await sign(payload, TEST_SECRET);

    expect(verifyWebhookSignature(payload, signature, "wrong_secret")).toBe(false);
  });

  it("returns false for a tampered payload", async () => {
    const payload = '{"event":"invoice.paid","data":{"invoiceId":"123"}}';
    const signature = await sign(payload, TEST_SECRET);

    const tampered = '{"event":"invoice.paid","data":{"invoiceId":"999"}}';
    expect(verifyWebhookSignature(tampered, signature, TEST_SECRET)).toBe(false);
  });

  it("returns false (never throws) when signature length differs", () => {
    const payload = '{"event":"invoice.paid"}';

    // Too short: 32 hex chars instead of 64
    expect(() =>
      verifyWebhookSignature(payload, "abcdef0123456789abcdef0123456789", TEST_SECRET),
    ).not.toThrow();
    expect(
      verifyWebhookSignature(payload, "abcdef0123456789abcdef0123456789", TEST_SECRET),
    ).toBe(false);

    // Too long: 128 hex chars
    expect(
      verifyWebhookSignature(payload, "ab".repeat(64), TEST_SECRET),
    ).toBe(false);
  });

  it("returns false (never throws) for malformed (non-hex) signatures", () => {
    const payload = '{"event":"invoice.paid"}';

    expect(() =>
      verifyWebhookSignature(payload, "not-hex!", TEST_SECRET),
    ).not.toThrow();
    expect(verifyWebhookSignature(payload, "not-hex!", TEST_SECRET)).toBe(false);

    // Odd-length hex string
    expect(() =>
      verifyWebhookSignature(payload, "abcde", TEST_SECRET),
    ).not.toThrow();
    expect(verifyWebhookSignature(payload, "abcde", TEST_SECRET)).toBe(false);
  });

  it("returns false for an empty signature", () => {
    const payload = '{"event":"invoice.paid"}';
    expect(verifyWebhookSignature(payload, "", TEST_SECRET)).toBe(false);
  });
});

describe("WebhookVerificationError", () => {
  it("is an Error subclass with the correct name", () => {
    const err = new WebhookVerificationError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(WebhookVerificationError);
    expect(err.name).toBe("WebhookVerificationError");
  });

  it("assert() does not throw for a valid signature", async () => {
    const payload = '{"event":"invoice.paid"}';
    const signature = await sign(payload, TEST_SECRET);

    expect(() =>
      WebhookVerificationError.assert(payload, signature, TEST_SECRET),
    ).not.toThrow();
  });

  it("assert() throws WebhookVerificationError for an invalid signature", async () => {
    const payload = '{"event":"invoice.paid"}';
    const signature = await sign(payload, TEST_SECRET);

    expect(() =>
      WebhookVerificationError.assert(payload + "x", signature, TEST_SECRET),
    ).toThrow(WebhookVerificationError);
  });

  it("assert() throws for a wrong secret", async () => {
    const payload = '{"event":"invoice.paid"}';
    const signature = await sign(payload, TEST_SECRET);

    expect(() =>
      WebhookVerificationError.assert(payload, signature, "nope"),
    ).toThrow(WebhookVerificationError);
  });
});

describe("index re-exports (Issue #617)", () => {
  it("re-exports verifyWebhookSignature from src/index.ts", async () => {
    expect(verifyFromIndex).toBe(verifyWebhookSignature);

    const payload = '{"event":"invoice.paid"}';
    const signature = await sign(payload, TEST_SECRET);
    expect(verifyFromIndex(payload, signature, TEST_SECRET)).toBe(true);
  });

  it("re-exports WebhookVerificationError from src/index.ts", () => {
    expect(VerificationErrorFromIndex).toBe(WebhookVerificationError);
  });
});