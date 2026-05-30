import { describe, expect, it } from "vitest";
import { validateWebhookSignature } from "../src/webhookValidator.js";
import crypto from "crypto";

describe("validateWebhookSignature", () => {
  it("returns true for a valid signature", async () => {
    const payload = { invoiceId: "123", amount: 42 };
    const secret = "test-secret";
    const validSignature = crypto
      .createHmac("sha256", secret)
      .update(JSON.stringify(payload))
      .digest("hex");

    expect(await validateWebhookSignature(payload, validSignature, secret)).toBe(true);
  });

  it("returns false when the payload has been tampered", async () => {
    const payload = { invoiceId: "123", amount: 42 };
    const secret = "test-secret";
    const validSignature = crypto
      .createHmac("sha256", secret)
      .update(JSON.stringify(payload))
      .digest("hex");

    const tamperedPayload = { invoiceId: "123", amount: 43 };
    expect(await validateWebhookSignature(tamperedPayload, validSignature, secret)).toBe(false);
  });
});
