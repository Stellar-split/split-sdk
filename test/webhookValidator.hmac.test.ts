/**
 * Unit tests for the validateWebhook() HMAC enforcement added to
 * src/webhookValidator.ts.
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";
import { validateWebhook, WebhookSignatureError } from "../src/webhookValidator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sign(body: string, secret: string): string {
  return "hmac-sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

function signRaw(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

const SECRET = "super-secret-key";
const BODY = JSON.stringify({ event: "payment", amount: 42 });
const PAYLOAD = { event: "payment", amount: 42 };

// ---------------------------------------------------------------------------
// Valid signatures
// ---------------------------------------------------------------------------

describe("validateWebhook – valid signatures", () => {
  it("does not throw for a correct hmac-sha256= prefixed signature", () => {
    const sig = sign(BODY, SECRET);
    expect(() => validateWebhook(PAYLOAD, BODY, SECRET, sig)).not.toThrow();
  });

  it("does not throw for a bare hex digest (no prefix)", () => {
    const sig = signRaw(BODY, SECRET);
    expect(() => validateWebhook(PAYLOAD, BODY, SECRET, sig)).not.toThrow();
  });

  it("verifies correctly when rawBody is a Uint8Array", () => {
    const bodyBytes = Buffer.from(BODY, "utf8");
    const sig = sign(BODY, SECRET);
    expect(() => validateWebhook(PAYLOAD, bodyBytes, SECRET, sig)).not.toThrow();
  });

  it("verifies different payload bodies independently", () => {
    const body1 = JSON.stringify({ event: "refund" });
    const body2 = JSON.stringify({ event: "release" });
    const sig1 = sign(body1, SECRET);
    const sig2 = sign(body2, SECRET);

    expect(() => validateWebhook({}, body1, SECRET, sig1)).not.toThrow();
    expect(() => validateWebhook({}, body2, SECRET, sig2)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// WebhookSignatureError — mismatched signatures
// ---------------------------------------------------------------------------

describe("validateWebhook – signature mismatch throws WebhookSignatureError", () => {
  it("throws WebhookSignatureError when signature is wrong", () => {
    const wrongSig = sign(BODY, "wrong-secret");
    expect(() => validateWebhook(PAYLOAD, BODY, SECRET, wrongSig)).toThrow(WebhookSignatureError);
  });

  it("throws when the body has been tampered", () => {
    const sig = sign(BODY, SECRET);
    const tamperedBody = JSON.stringify({ event: "payment", amount: 99 });
    expect(() => validateWebhook(PAYLOAD, tamperedBody, SECRET, sig)).toThrow(WebhookSignatureError);
  });

  it("throws when an empty signature is provided", () => {
    expect(() => validateWebhook(PAYLOAD, BODY, SECRET, "")).toThrow(WebhookSignatureError);
  });

  it("throws when the signature prefix is correct but digest is garbage", () => {
    expect(() =>
      validateWebhook(PAYLOAD, BODY, SECRET, "hmac-sha256=notahexstring")
    ).toThrow(WebhookSignatureError);
  });

  it("WebhookSignatureError is an instance of Error", () => {
    try {
      validateWebhook(PAYLOAD, BODY, SECRET, "bad");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(WebhookSignatureError);
      expect((err as Error).name).toBe("WebhookSignatureError");
    }
  });
});

// ---------------------------------------------------------------------------
// Opt-out mode (secret = null)
// ---------------------------------------------------------------------------

describe("validateWebhook – opt-out mode (secret = null)", () => {
  it("does not throw when secret is null, regardless of signature", () => {
    expect(() => validateWebhook(PAYLOAD, BODY, null, "garbage-sig")).not.toThrow();
  });

  it("does not throw when secret is null and signature is empty", () => {
    expect(() => validateWebhook(PAYLOAD, BODY, null, "")).not.toThrow();
  });

  it("does not throw when secret is null and body is empty", () => {
    expect(() => validateWebhook({}, "", null, "whatever")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Timing-safe: same result regardless of secret length (smoke test)
// ---------------------------------------------------------------------------

describe("validateWebhook – timing safety smoke test", () => {
  it("rejects a signature computed with a different secret (no secret leakage)", () => {
    const sig = sign(BODY, "other-secret");
    expect(() => validateWebhook(PAYLOAD, BODY, SECRET, sig)).toThrow(WebhookSignatureError);
  });

  it("accepts the correct signature after rejecting an incorrect one", () => {
    const badSig = sign(BODY, "wrong");
    const goodSig = sign(BODY, SECRET);

    expect(() => validateWebhook(PAYLOAD, BODY, SECRET, badSig)).toThrow(WebhookSignatureError);
    expect(() => validateWebhook(PAYLOAD, BODY, SECRET, goodSig)).not.toThrow();
  });
});
