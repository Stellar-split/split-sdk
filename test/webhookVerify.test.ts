import { describe, it, expect } from "vitest";
import {
  verifyWebhookSignature,
  WebhookVerificationError,
  verifyWebhookSignatureOrThrow,
} from "../src/webhooks/verify.js";
import { createHmac } from "crypto";

const TEST_SECRET = "my-super-secret";

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

describe("verifyWebhookSignature", () => {
  it("returns true for a valid signature", () => {
    const payload = '{"event":"invoice.created"}';
    const signature = sign(payload, TEST_SECRET);
    expect(verifyWebhookSignature(payload, signature, TEST_SECRET)).toBe(true);
  });

  it("returns false for a wrong secret", () => {
    const payload = '{"event":"invoice.created"}';
    const signature = sign(payload, TEST_SECRET);
    expect(verifyWebhookSignature(payload, signature, "wrong-secret")).toBe(false);
  });

  it("returns false for a tampered payload", () => {
    const payload = '{"event":"invoice.created"}';
    const signature = sign(payload, TEST_SECRET);
    expect(verifyWebhookSignature(payload + "x", signature, TEST_SECRET)).toBe(false);
  });

  it("returns false when signature length mismatches", () => {
    const payload = '{"event":"invoice.created"}';
    expect(verifyWebhookSignature(payload, "abcd", TEST_SECRET)).toBe(false);
  });

  it("returns false for malformed hex signature", () => {
    const payload = '{"event":"invoice.created"}';
    expect(verifyWebhookSignature(payload, "not-hex!", TEST_SECRET)).toBe(false);
  });

  it("returns false for odd-length hex", () => {
    const payload = '{"event":"invoice.created"}';
    expect(verifyWebhookSignature(payload, "abc", TEST_SECRET)).toBe(false);
  });
});

describe("verifyWebhookSignatureOrThrow", () => {
  it("does not throw for a valid signature", () => {
    const payload = '{"event":"invoice.created"}';
    const signature = sign(payload, TEST_SECRET);
    expect(() => verifyWebhookSignatureOrThrow(payload, signature, TEST_SECRET)).not.toThrow();
  });

  it("throws WebhookVerificationError for an invalid signature", () => {
    const payload = '{"event":"invoice.created"}';
    const signature = sign(payload, TEST_SECRET);
    expect(() =>
      verifyWebhookSignatureOrThrow(payload, signature, "wrong-secret")
    ).toThrow(WebhookVerificationError);
  });
});

describe("WebhookVerificationError", () => {
  it("has the correct name and message", () => {
    const err = new WebhookVerificationError();
    expect(err.name).toBe("WebhookVerificationError");
    expect(err.message).toBe("Webhook signature verification failed");
  });
});
