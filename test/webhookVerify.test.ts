// @vitest-environment node

import { describe, expect, it } from "vitest";
import { createHmac } from "crypto";
import {
  verifyWebhookSignature,
  WebhookVerificationError,
  assertWebhookSignature,
} from "../src/webhooks/verify.js";
import { StellarSplitError } from "../src/errors.js";
import * as sdk from "../src/index.js";

describe("verifyWebhookSignature and WebhookVerificationError", () => {
  const secret = "super_secret_key_12345!@#";
  const payload = JSON.stringify({
    event: "invoice.paid",
    timestamp: 1724930400,
    data: {
      invoiceId: "inv_stellar_123",
      amount: "10000000",
      payer: "GBBD...XYZ",
    },
  });

  const validSignature = createHmac("sha256", secret).update(payload).digest("hex");

  describe("SDK root exports", () => {
    it("exports verifyWebhookSignature and WebhookVerificationError from index.ts", () => {
      expect(typeof sdk.verifyWebhookSignature).toBe("function");
      expect(typeof sdk.WebhookVerificationError).toBe("function");
      expect(typeof sdk.assertWebhookSignature).toBe("function");
    });
  });

  describe("verifyWebhookSignature", () => {
    it("returns true for a valid signature matching payload and secret", () => {
      const isValid = verifyWebhookSignature(payload, validSignature, secret);
      expect(isValid).toBe(true);
    });

    it("returns true for uppercase hex signature", () => {
      const uppercaseSig = validSignature.toUpperCase();
      const isValid = verifyWebhookSignature(payload, uppercaseSig, secret);
      expect(isValid).toBe(true);
    });

    it("returns false for an incorrect secret", () => {
      const wrongSecret = "wrong_secret_key_67890";
      const isValid = verifyWebhookSignature(payload, validSignature, wrongSecret);
      expect(isValid).toBe(false);
    });

    it("returns false when payload has been tampered with", () => {
      const tamperedPayload = JSON.stringify({
        event: "invoice.paid",
        timestamp: 1724930400,
        data: {
          invoiceId: "inv_stellar_123",
          amount: "99999999", // Modified amount
          payer: "GBBD...XYZ",
        },
      });
      const isValid = verifyWebhookSignature(tamperedPayload, validSignature, secret);
      expect(isValid).toBe(false);
    });

    it("returns false without throwing when signature length is mismatched", () => {
      const shortSig = "abcdef123456";
      const longSig = validSignature + "abcdef";

      expect(() => {
        const resShort = verifyWebhookSignature(payload, shortSig, secret);
        expect(resShort).toBe(false);
      }).not.toThrow();

      expect(() => {
        const resLong = verifyWebhookSignature(payload, longSig, secret);
        expect(resLong).toBe(false);
      }).not.toThrow();
    });

    it("returns false without throwing for odd length signature", () => {
      const oddSig = "abcde";
      expect(() => {
        const result = verifyWebhookSignature(payload, oddSig, secret);
        expect(result).toBe(false);
      }).not.toThrow();
    });

    it("returns false without throwing for malformed non-hex signature", () => {
      const nonHexSig = "not_a_valid_hex_signature_string_at_all!!";
      expect(() => {
        const result = verifyWebhookSignature(payload, nonHexSig, secret);
        expect(result).toBe(false);
      }).not.toThrow();
    });

    it("returns false without throwing for empty signature", () => {
      expect(() => {
        const result = verifyWebhookSignature(payload, "", secret);
        expect(result).toBe(false);
      }).not.toThrow();
    });

    it("returns false without throwing for non-string inputs", () => {
      // @ts-expect-error test invalid inputs
      expect(verifyWebhookSignature(null, validSignature, secret)).toBe(false);
      // @ts-expect-error test invalid inputs
      expect(verifyWebhookSignature(payload, null, secret)).toBe(false);
      // @ts-expect-error test invalid inputs
      expect(verifyWebhookSignature(payload, validSignature, null)).toBe(false);
      // @ts-expect-error test invalid inputs
      expect(verifyWebhookSignature(undefined, undefined, undefined)).toBe(false);
    });

    it("verifies empty string payload correctly", () => {
      const emptyPayload = "";
      const emptyPayloadSig = createHmac("sha256", secret).update(emptyPayload).digest("hex");
      expect(verifyWebhookSignature(emptyPayload, emptyPayloadSig, secret)).toBe(true);
      expect(verifyWebhookSignature(emptyPayload, validSignature, secret)).toBe(false);
    });
  });

  describe("WebhookVerificationError", () => {
    it("is an instance of StellarSplitError and Error", () => {
      const err = new WebhookVerificationError("Custom error message");
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(StellarSplitError);
      expect(err.name).toBe("WebhookVerificationError");
      expect(err.code).toBe("WEBHOOK_VERIFICATION_FAILED");
      expect(err.message).toBe("Custom error message");
    });

    it("WebhookVerificationError.verify does not throw on valid signature", () => {
      expect(() => {
        WebhookVerificationError.verify(payload, validSignature, secret);
      }).not.toThrow();
    });

    it("WebhookVerificationError.verify throws WebhookVerificationError on invalid signature", () => {
      expect(() => {
        WebhookVerificationError.verify(payload, "invalid_signature", secret);
      }).toThrow(WebhookVerificationError);

      expect(() => {
        WebhookVerificationError.verify(payload, validSignature, "wrong_secret");
      }).toThrow(WebhookVerificationError);
    });

    it("WebhookVerificationError.assert does not throw on valid signature", () => {
      expect(() => {
        WebhookVerificationError.assert(payload, validSignature, secret);
      }).not.toThrow();
    });

    it("WebhookVerificationError.assert throws WebhookVerificationError on invalid signature", () => {
      expect(() => {
        WebhookVerificationError.assert(payload, "invalid_signature", secret);
      }).toThrow(WebhookVerificationError);
    });

    it("assertWebhookSignature standalone function works as expected", () => {
      expect(() => {
        assertWebhookSignature(payload, validSignature, secret);
      }).not.toThrow();

      expect(() => {
        assertWebhookSignature(payload, "tampered_signature", secret);
      }).toThrow(WebhookVerificationError);
    });
  });
});
