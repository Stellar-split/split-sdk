import {
  verifyWebhookSignature,
  verifyWebhookSignatureOrThrow,
  WebhookVerificationError,
} from "../src/webhooks/verify.js";

describe("verifyWebhookSignature", () => {
  const secret = "my-secret-key";
  const payload = '{"event":"invoice.paid","data":{"id":"123"}}';

  it("returns true for a valid signature", () => {
    const crypto = require("crypto");
    const expected = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex");
    expect(verifyWebhookSignature(payload, expected, secret)).toBe(true);
  });

  it("returns false for a wrong secret", () => {
    const crypto = require("crypto");
    const expected = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex");
    expect(verifyWebhookSignature(payload, expected, "wrong-secret")).toBe(
      false,
    );
  });

  it("returns false for a tampered payload", () => {
    const crypto = require("crypto");
    const expected = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex");
    expect(
      verifyWebhookSignature(payload + "x", expected, secret),
    ).toBe(false);
  });

  it("returns false for a malformed signature (non-hex)", () => {
    expect(verifyWebhookSignature(payload, "not-hex!", secret)).toBe(false);
  });

  it("returns false when signature lengths differ", () => {
    expect(verifyWebhookSignature(payload, "abcd", secret)).toBe(false);
  });

  it("never throws", () => {
    expect(() =>
      verifyWebhookSignature(payload, "bad-sig", secret),
    ).not.toThrow();
  });
});

describe("verifyWebhookSignatureOrThrow", () => {
  const secret = "my-secret-key";
  const payload = "test-payload";

  it("does not throw for a valid signature", () => {
    const crypto = require("crypto");
    const sig = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex");
    expect(() => verifyWebhookSignatureOrThrow(payload, sig, secret)).not.toThrow();
  });

  it("throws WebhookVerificationError for an invalid signature", () => {
    expect(() =>
      verifyWebhookSignatureOrThrow(payload, "bad-sig", secret),
    ).toThrow(WebhookVerificationError);
  });
});

describe("WebhookVerificationError", () => {
  it("has the correct name", () => {
    const err = new WebhookVerificationError();
    expect(err.name).toBe("WebhookVerificationError");
  });

  it("accepts a custom message", () => {
    const err = new WebhookVerificationError("custom msg");
    expect(err.message).toBe("custom msg");
  });
});
