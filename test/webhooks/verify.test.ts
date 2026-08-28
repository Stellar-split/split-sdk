import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";
import {
  verifyWebhookSignature,
  assertWebhookSignature,
  WebhookVerificationError,
} from "../../src/webhooks/verify.js";
import * as IndexExports from "../../src/index.js";

const TEST_SECRET = "super_secret_signing_key_12345";
const TEST_PAYLOAD = JSON.stringify({
  event: "invoice.paid",
  invoiceId: "inv_stellar_9999",
  amount: "5000000",
  timestamp: 1724800000,
});

function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

describe("verifyWebhookSignature (Issue #617)", () => {
  it("exports verifyWebhookSignature and WebhookVerificationError from index.ts", () => {
    expect(typeof IndexExports.verifyWebhookSignature).toBe("function");
    expect(typeof IndexExports.assertWebhookSignature).toBe("function");
    expect(IndexExports.WebhookVerificationError).toBeDefined();
  });

  it("verifies valid HMAC-SHA256 signature (payload, signature, secret)", () => {
    const signature = signPayload(TEST_PAYLOAD, TEST_SECRET);
    const result = verifyWebhookSignature(TEST_PAYLOAD, signature, TEST_SECRET);
    expect(result).toBe(true);
  });

  it("verifies valid HMAC-SHA256 signature with (secret, rawBody, signatureHeader)", () => {
    const signature = signPayload(TEST_PAYLOAD, TEST_SECRET);
    const result = verifyWebhookSignature(TEST_SECRET, TEST_PAYLOAD, signature);
    expect(result).toBe(true);
  });

  it("returns false for wrong secret", () => {
    const signature = signPayload(TEST_PAYLOAD, TEST_SECRET);
    const result = verifyWebhookSignature(TEST_PAYLOAD, signature, "wrong_secret");
    expect(result).toBe(false);
  });

  it("returns false for tampered payload", () => {
    const signature = signPayload(TEST_PAYLOAD, TEST_SECRET);
    const tamperedPayload = TEST_PAYLOAD.replace("5000000", "9999999");
    const result = verifyWebhookSignature(tamperedPayload, signature, TEST_SECRET);
    expect(result).toBe(false);
  });

  it("returns false for signature with mismatched length without throwing", () => {
    const shortSig = "abcdef1234";
    const longSig = "a".repeat(128);
    expect(verifyWebhookSignature(TEST_PAYLOAD, shortSig, TEST_SECRET)).toBe(false);
    expect(verifyWebhookSignature(TEST_PAYLOAD, longSig, TEST_SECRET)).toBe(false);
  });

  it("returns false for non-hex signature without throwing", () => {
    const invalidHex = "not_a_valid_hex_string_xyz!";
    expect(verifyWebhookSignature(TEST_PAYLOAD, invalidHex, TEST_SECRET)).toBe(false);
  });

  it("returns false for odd-length signature without throwing", () => {
    const oddHex = "abc";
    expect(verifyWebhookSignature(TEST_PAYLOAD, oddHex, TEST_SECRET)).toBe(false);
  });

  it("returns false for non-string inputs without throwing", () => {
    expect(verifyWebhookSignature(null as any, "sig", TEST_SECRET)).toBe(false);
    expect(verifyWebhookSignature(TEST_PAYLOAD, null as any, TEST_SECRET)).toBe(false);
    expect(verifyWebhookSignature(TEST_PAYLOAD, "sig", undefined as any)).toBe(false);
  });

  it("assertWebhookSignature passes with valid signature", () => {
    const signature = signPayload(TEST_PAYLOAD, TEST_SECRET);
    expect(() => {
      assertWebhookSignature(TEST_PAYLOAD, signature, TEST_SECRET);
    }).not.toThrow();
  });

  it("assertWebhookSignature throws WebhookVerificationError with invalid signature", () => {
    expect(() => {
      assertWebhookSignature(TEST_PAYLOAD, "0".repeat(64), TEST_SECRET);
    }).toThrow(WebhookVerificationError);
  });

  it("WebhookVerificationError instances have proper inheritance and name", () => {
    const err = new WebhookVerificationError("Custom verification error");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(WebhookVerificationError);
    expect(err.name).toBe("WebhookVerificationError");
    expect(err.message).toBe("Custom verification error");
  });
});
