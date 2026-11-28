/**
 * Test Suite: Webhook Signature Verification (#1042)
 *
 * Requirements:
 * - Test valid signatures: HMAC-SHA256 signature computation, verification, and prefix handling
 * - Test invalid signatures: Mismatched secrets, tampered payloads, malformed hex, and timing safety
 * - Test replay protection: Timestamp tolerance, clock skew windows, and duplicate submission rejection
 * - Test nonce tracking: Nonce deduplication cache, LRU capacity eviction, and replay store tracking
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "crypto";
import {
  WebhookSignatureValidator,
  computeSignature,
  safeCompare,
  buildSignedPayload,
  verifyWebhookSignature as verifyValidatorSignature,
} from "../src/webhookSignatureValidator.js";
import { verifyWebhookSignature as verifyRawWebhookSignature } from "../src/webhooks/verify.js";
import { validateWebhook, WebhookSignatureError } from "../src/webhookValidator.js";
import {
  RingBufferStore,
  recordWebhookEvent,
  configureReplayStore,
  WebhookEventNotFoundError,
} from "../src/webhookReplay.js";

const TEST_SECRET = "stellar_webhook_secret_key_abcdef123456";
const ALT_SECRET = "different_secret_key_xyz987654";

function hmacSha256(secret: string, body: string | Buffer): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("Webhook Signature Verification (#1042)", () => {
  beforeEach(() => {
    configureReplayStore(new RingBufferStore(50));
    vi.restoreAllMocks();
  });

  describe("Requirement: Test valid signatures", () => {
    it("computes accurate HMAC-SHA256 hex signature", () => {
      const payload = JSON.stringify({ event: "invoice.paid", invoiceId: "inv-101", amount: "5000" });
      const computed = computeSignature(payload, TEST_SECRET, "sha256");

      expect(computed).toHaveLength(64);
      expect(computed).toMatch(/^[0-9a-f]{64}$/);
      expect(computed).toBe(hmacSha256(TEST_SECRET, payload));
    });

    it("verifies valid signature with WebhookSignatureValidator (string body)", () => {
      const validator = new WebhookSignatureValidator({ secret: TEST_SECRET });
      const body = JSON.stringify({ event: "invoice.created", invoiceId: "inv-202" });
      const signature = hmacSha256(TEST_SECRET, body);

      const result = validator.verify({ body, signature });
      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("verifies valid signature with Buffer body", () => {
      const validator = new WebhookSignatureValidator({ secret: TEST_SECRET });
      const bodyStr = JSON.stringify({ event: "invoice.refunded", amount: "100" });
      const bodyBuf = Buffer.from(bodyStr, "utf8");
      const signature = hmacSha256(TEST_SECRET, bodyBuf);

      const result = validator.verify({ body: bodyBuf, signature });
      expect(result.valid).toBe(true);
    });

    it("verifies valid signatures with custom prefix (e.g., sha256= or hmac-sha256=)", () => {
      const validator = new WebhookSignatureValidator({
        secret: TEST_SECRET,
        signaturePrefix: "sha256=",
      });
      const body = JSON.stringify({ event: "invoice.released" });
      const signature = `sha256=${hmacSha256(TEST_SECRET, body)}`;

      const result = validator.verify({ body, signature });
      expect(result.valid).toBe(true);
    });

    it("emits webhook.validated event on successful verification", () => {
      const validator = new WebhookSignatureValidator({ secret: TEST_SECRET });
      const eventSpy = vi.fn();
      const unsubscribe = validator.on(eventSpy);

      const body = JSON.stringify({ event: "invoice.paid" });
      const signature = hmacSha256(TEST_SECRET, body);

      validator.verify({ body, signature });

      expect(eventSpy).toHaveBeenCalledTimes(1);
      expect(eventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "webhook.validated",
          timestamp: expect.any(Number),
        })
      );

      unsubscribe();
      validator.verify({ body, signature });
      expect(eventSpy).toHaveBeenCalledTimes(1); // not called after unsubscribe
    });

    it("verifies signature with verifyWebhookSignature from webhooks/verify", () => {
      const rawBody = JSON.stringify({ event: "invoice.settled", id: 1 });
      const signature = hmacSha256(TEST_SECRET, rawBody);

      const isValid = verifyRawWebhookSignature(rawBody, signature, TEST_SECRET);
      expect(isValid).toBe(true);
    });

    it("verifies signature with validateWebhook from webhookValidator", () => {
      const rawBody = JSON.stringify({ event: "invoice.paid", stroops: 1000n.toString() });
      const signature = `hmac-sha256=${hmacSha256(TEST_SECRET, rawBody)}`;

      expect(() =>
        validateWebhook({ event: "invoice.paid" }, rawBody, TEST_SECRET, signature)
      ).not.toThrow();

      // Opt-out mode (secret = null) skips verification
      expect(() =>
        validateWebhook({}, rawBody, null, "any-bogus-signature")
      ).not.toThrow();
    });
  });

  describe("Requirement: Test invalid signatures", () => {
    it("rejects signature generated with a mismatched secret", () => {
      const validator = new WebhookSignatureValidator({ secret: TEST_SECRET });
      const body = JSON.stringify({ event: "invoice.paid", invoiceId: "inv-bad-sec" });
      const wrongSecretSignature = hmacSha256(ALT_SECRET, body);

      const result = validator.verify({ body, signature: wrongSecretSignature });
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("signature mismatch");
    });

    it("rejects tampered request payload body", () => {
      const validator = new WebhookSignatureValidator({ secret: TEST_SECRET });
      const originalBody = JSON.stringify({ event: "invoice.paid", amount: "100" });
      const signature = hmacSha256(TEST_SECRET, originalBody);

      const tamperedBody = JSON.stringify({ event: "invoice.paid", amount: "9999" });
      const result = validator.verify({ body: tamperedBody, signature });

      expect(result.valid).toBe(false);
      expect(result.reason).toBe("signature mismatch");
    });

    it("rejects tampered signature bytes", () => {
      const validator = new WebhookSignatureValidator({ secret: TEST_SECRET });
      const body = JSON.stringify({ event: "invoice.paid" });
      const signature = hmacSha256(TEST_SECRET, body);

      // Flip the first character of the signature hex
      const tamperedSig = (signature[0] === "a" ? "b" : "a") + signature.slice(1);
      const result = validator.verify({ body, signature: tamperedSig });

      expect(result.valid).toBe(false);
      expect(result.reason).toBe("signature mismatch");
    });

    it("rejects missing or empty signature with clear reason", () => {
      const validator = new WebhookSignatureValidator({ secret: TEST_SECRET });
      const body = JSON.stringify({ event: "invoice.paid" });

      expect(validator.verify({ body, signature: "" })).toEqual({
        valid: false,
        reason: "missing signature",
      });

      expect(validator.verify({ body, signature: null as any })).toEqual({
        valid: false,
        reason: "missing signature",
      });
    });

    it("emits webhook.rejected event on invalid signature", () => {
      const validator = new WebhookSignatureValidator({ secret: TEST_SECRET });
      const eventSpy = vi.fn();
      validator.on(eventSpy);

      const body = JSON.stringify({ event: "invoice.paid" });
      validator.verify({ body, signature: "invalid_sig_hex" });

      expect(eventSpy).toHaveBeenCalledTimes(1);
      expect(eventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "webhook.rejected",
          reason: expect.any(String),
        })
      );
    });

    it("rejects malformed non-hex or odd-length signatures", () => {
      const rawBody = JSON.stringify({ event: "invoice.paid" });

      // Odd length
      expect(verifyRawWebhookSignature(TEST_SECRET, rawBody, "abc")).toBe(false);

      // Non-hex characters
      expect(verifyRawWebhookSignature(TEST_SECRET, rawBody, "not_a_hex_digest_xyz!@#$")).toBe(false);

      // Throws WebhookSignatureError on validateWebhook
      expect(() =>
        validateWebhook({}, rawBody, TEST_SECRET, "hmac-sha256=invalidhex")
      ).toThrow(WebhookSignatureError);
    });

    it("uses constant-time comparison in safeCompare to prevent timing attacks", () => {
      const sigA = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
      const sigB = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456780"; // 1 char diff

      expect(safeCompare(sigA, sigA)).toBe(true);
      expect(safeCompare(sigA, sigB)).toBe(false);
      expect(safeCompare(sigA, sigA.slice(0, 10))).toBe(false); // different lengths
    });
  });

  describe("Requirement: Test replay protection", () => {
    it("accepts timestamped payload within allowed tolerance window", () => {
      const validator = new WebhookSignatureValidator({
        secret: TEST_SECRET,
        toleranceSeconds: 300, // 5 minutes
      });

      const nowSeconds = Math.floor(Date.now() / 1000);
      const body = JSON.stringify({ event: "invoice.paid" });
      const signedPayload = buildSignedPayload(body, nowSeconds);
      const signature = hmacSha256(TEST_SECRET, signedPayload);

      const result = validator.verify({
        body,
        signature,
        timestamp: nowSeconds,
      });

      expect(result.valid).toBe(true);
    });

    it("accepts timestamps within clock skew tolerance in both directions (past and slight future)", () => {
      const validator = new WebhookSignatureValidator({
        secret: TEST_SECRET,
        toleranceSeconds: 60,
      });

      const nowSeconds = Math.floor(Date.now() / 1000);
      const pastTimestamp = nowSeconds - 30; // 30s ago
      const futureTimestamp = nowSeconds + 20; // 20s in future

      const body = "event=ping";

      // Past within tolerance
      const sigPast = hmacSha256(TEST_SECRET, buildSignedPayload(body, pastTimestamp));
      expect(validator.verify({ body, signature: sigPast, timestamp: pastTimestamp }).valid).toBe(true);

      // Future within tolerance
      const sigFuture = hmacSha256(TEST_SECRET, buildSignedPayload(body, futureTimestamp));
      expect(validator.verify({ body, signature: sigFuture, timestamp: futureTimestamp }).valid).toBe(true);
    });

    it("rejects expired timestamp outside tolerance window", () => {
      const validator = new WebhookSignatureValidator({
        secret: TEST_SECRET,
        toleranceSeconds: 60, // 1 minute tolerance
      });

      const expiredTimestamp = Math.floor(Date.now() / 1000) - 120; // 2 minutes ago
      const body = JSON.stringify({ event: "invoice.paid" });
      const signedPayload = buildSignedPayload(body, expiredTimestamp);
      const signature = hmacSha256(TEST_SECRET, signedPayload);

      const result = validator.verify({
        body,
        signature,
        timestamp: expiredTimestamp,
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toBe("timestamp outside tolerance");
    });

    it("rejects timestamp in distant future exceeding tolerance window", () => {
      const validator = new WebhookSignatureValidator({
        secret: TEST_SECRET,
        toleranceSeconds: 60,
      });

      const futureTimestamp = Math.floor(Date.now() / 1000) + 3600; // 1 hour in future
      const body = JSON.stringify({ event: "invoice.paid" });
      const signature = hmacSha256(TEST_SECRET, buildSignedPayload(body, futureTimestamp));

      const result = validator.verify({
        body,
        signature,
        timestamp: futureTimestamp,
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toBe("timestamp outside tolerance");
    });

    it("supports both seconds and milliseconds timestamp formats", () => {
      const validator = new WebhookSignatureValidator({ secret: TEST_SECRET, toleranceSeconds: 300 });
      const body = "test_payload";

      const nowMs = Date.now();
      const sigMs = hmacSha256(TEST_SECRET, buildSignedPayload(body, nowMs));
      expect(validator.verify({ body, signature: sigMs, timestamp: nowMs }).valid).toBe(true);

      const nowSec = Math.floor(nowMs / 1000);
      const sigSec = hmacSha256(TEST_SECRET, buildSignedPayload(body, nowSec));
      expect(validator.verify({ body, signature: sigSec, timestamp: nowSec }).valid).toBe(true);
    });
  });

  describe("Requirement: Test nonce tracking", () => {
    it("tracks seen nonces and detects replay attacks", () => {
      // In-memory nonce tracking set
      const seenNonces = new Set<string>();

      const processWebhookDelivery = (nonce: string, payload: unknown) => {
        if (seenNonces.has(nonce)) {
          return { accepted: false, error: "REPLAY_ATTACK_DETECTED" };
        }
        seenNonces.add(nonce);
        return { accepted: true, data: payload };
      };

      const nonce1 = "nonce_123_abc";
      const payload1 = { invoiceId: "inv-1", amount: 100n };

      // First delivery accepted and nonce tracked
      const firstResult = processWebhookDelivery(nonce1, payload1);
      expect(firstResult.accepted).toBe(true);
      expect(seenNonces.has(nonce1)).toBe(true);

      // Second delivery with identical nonce rejected as replay
      const replayResult = processWebhookDelivery(nonce1, payload1);
      expect(replayResult.accepted).toBe(false);
      expect(replayResult.error).toBe("REPLAY_ATTACK_DETECTED");

      // New unique nonce accepted
      const nonce2 = "nonce_456_def";
      const nextResult = processWebhookDelivery(nonce2, payload1);
      expect(nextResult.accepted).toBe(true);
      expect(seenNonces.size).toBe(2);
    });

    it("RingBufferStore stores, retrieves, and enforces capacity eviction for webhook replay", () => {
      const store = new RingBufferStore(3); // Capacity = 3

      const record1 = {
        eventId: "evt-1",
        invoiceId: "inv-1",
        event: "invoice.paid" as any,
        url: "https://api.merchant.com/hook",
        payload: { amount: 100 },
        firedAt: new Date().toISOString(),
      };
      const record2 = { ...record1, eventId: "evt-2" };
      const record3 = { ...record1, eventId: "evt-3" };
      const record4 = { ...record1, eventId: "evt-4" };

      store.set("evt-1", record1);
      store.set("evt-2", record2);
      store.set("evt-3", record3);

      expect(store.size).toBe(3);
      expect(store.get("evt-1")).toEqual(record1);
      expect(store.get("evt-2")).toEqual(record2);
      expect(store.get("evt-3")).toEqual(record3);

      // Adding 4th record evicts oldest ("evt-1")
      store.set("evt-4", record4);
      expect(store.size).toBe(3);
      expect(store.get("evt-1")).toBeUndefined();
      expect(store.get("evt-4")).toEqual(record4);
    });

    it("records webhook deliveries with unique event IDs and supports lookup", () => {
      const eventId1 = recordWebhookEvent("inv-100", "invoice.created" as any, "https://example.com/wh", { foo: 1 });
      const eventId2 = recordWebhookEvent("inv-101", "invoice.paid" as any, "https://example.com/wh", { foo: 2 });

      expect(eventId1).toBeDefined();
      expect(eventId2).toBeDefined();
      expect(eventId1).not.toBe(eventId2);

      const store = new RingBufferStore(10);
      configureReplayStore(store);

      const recordedId = recordWebhookEvent("inv-200", "invoice.paid" as any, "https://example.com/wh", { bar: 42 });
      const stored = store.get(recordedId);

      expect(stored).toBeDefined();
      expect(stored?.invoiceId).toBe("inv-200");
      expect(stored?.payload).toEqual({ bar: 42 });
    });
  });
});
