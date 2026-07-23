/**
 * Test suite for webhookMiddleware module.
 * 
 * Tests cover:
 * - HMAC-SHA256 signature verification
 * - Timestamp validation and tolerance
 * - Nonce-based replay attack prevention
 * - LRU cache behavior
 * - Error handling and edge cases
 * - Express middleware integration
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import {
  createWebhookMiddleware,
  generateWebhookSignature,
  verifyWebhookSignature,
  parseWebhookPayload,
  isValidEventType,
  isWebhookRequest,
  InvalidSignatureError,
  TimestampOutOfBoundsError,
  ReplayAttackError,
  MissingHeaderError,
  InvalidPayloadError,
  type WebhookPayload,
  type WebhookRequest,
  type InvoiceEventType,
} from "../src/webhookMiddleware.js";

// ============================================================================
// Test Helpers
// ============================================================================

const TEST_SECRET = "test_secret_key_12345";

/**
 * Create a valid webhook payload for testing.
 */
function createTestPayload(
  event: InvoiceEventType = "invoice.paid",
  data: unknown = { invoiceId: "123", amount: "1000" },
): WebhookPayload {
  return {
    event,
    timestamp: Math.floor(Date.now() / 1000),
    nonce: `nonce_${Date.now()}_${Math.random()}`,
    data,
  };
}

/**
 * Create a mock Express request object.
 */
function createMockRequest(
  body: Buffer | string | object,
  headers: Record<string, string> = {},
): Partial<Request> {
  return {
    body,
    headers: headers,
  };
}

/**
 * Create a mock Express response object.
 */
function createMockResponse(): Partial<Response> {
  const res: Partial<Response> = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res;
}

/**
 * Create a mock Express next function.
 */
function createMockNext(): NextFunction {
  return vi.fn();
}

// ============================================================================
// Signature Generation & Verification Tests
// ============================================================================

describe("generateWebhookSignature", () => {
  it("should generate a valid HMAC-SHA256 signature", async () => {
    const payload = createTestPayload();
    const signature = await generateWebhookSignature(payload, TEST_SECRET);

    expect(signature).toBeDefined();
    expect(typeof signature).toBe("string");
    expect(signature.length).toBe(64); // SHA-256 produces 32 bytes = 64 hex chars
    expect(signature).toMatch(/^[0-9a-f]{64}$/); // Valid hex string
  });

  it("should generate different signatures for different payloads", async () => {
    const payload1 = createTestPayload("invoice.paid");
    const payload2 = createTestPayload("invoice.released");

    const sig1 = await generateWebhookSignature(payload1, TEST_SECRET);
    const sig2 = await generateWebhookSignature(payload2, TEST_SECRET);

    expect(sig1).not.toBe(sig2);
  });

  it("should generate different signatures for different secrets", async () => {
    const payload = createTestPayload();

    const sig1 = await generateWebhookSignature(payload, "secret1");
    const sig2 = await generateWebhookSignature(payload, "secret2");

    expect(sig1).not.toBe(sig2);
  });

  it("should generate consistent signatures for the same payload and secret", async () => {
    const payload = createTestPayload();

    const sig1 = await generateWebhookSignature(payload, TEST_SECRET);
    const sig2 = await generateWebhookSignature(payload, TEST_SECRET);

    expect(sig1).toBe(sig2);
  });
});

describe("verifyWebhookSignature", () => {
  it("should verify a valid signature", async () => {
    const payload = createTestPayload();
    const signature = await generateWebhookSignature(payload, TEST_SECRET);

    const isValid = await verifyWebhookSignature(payload, signature, TEST_SECRET);
    expect(isValid).toBe(true);
  });

  it("should verify a valid signature from string payload", async () => {
    const payload = createTestPayload();
    const payloadString = JSON.stringify(payload);
    const signature = await generateWebhookSignature(payload, TEST_SECRET);

    const isValid = await verifyWebhookSignature(
      payloadString,
      signature,
      TEST_SECRET,
    );
    expect(isValid).toBe(true);
  });

  it("should reject an invalid signature", async () => {
    const payload = createTestPayload();
    const invalidSignature = "0".repeat(64);

    const isValid = await verifyWebhookSignature(
      payload,
      invalidSignature,
      TEST_SECRET,
    );
    expect(isValid).toBe(false);
  });

  it("should reject a signature with wrong secret", async () => {
    const payload = createTestPayload();
    const signature = await generateWebhookSignature(payload, "wrong_secret");

    const isValid = await verifyWebhookSignature(payload, signature, TEST_SECRET);
    expect(isValid).toBe(false);
  });

  it("should reject a tampered payload", async () => {
    const payload = createTestPayload();
    const signature = await generateWebhookSignature(payload, TEST_SECRET);

    // Tamper with the payload
    const tamperedPayload = { ...payload, data: { tampered: true } };

    const isValid = await verifyWebhookSignature(
      tamperedPayload,
      signature,
      TEST_SECRET,
    );
    expect(isValid).toBe(false);
  });

  it("should handle malformed hex signature gracefully", async () => {
    const payload = createTestPayload();
    const invalidHex = "not_a_hex_string";

    const isValid = await verifyWebhookSignature(payload, invalidHex, TEST_SECRET);
    expect(isValid).toBe(false);
  });

  it("should handle signature with odd length gracefully", async () => {
    const payload = createTestPayload();
    const oddLengthHex = "abc"; // Odd number of hex chars

    const isValid = await verifyWebhookSignature(
      payload,
      oddLengthHex,
      TEST_SECRET,
    );
    expect(isValid).toBe(false);
  });
});

// ============================================================================
// Webhook Middleware Tests
// ============================================================================

describe("createWebhookMiddleware", () => {
  it("should throw if secret is empty", () => {
    expect(() => createWebhookMiddleware("")).toThrow("non-empty string");
  });

  it("should throw if secret is not a string", () => {
    expect(() => createWebhookMiddleware(null as any)).toThrow("non-empty string");
    expect(() => createWebhookMiddleware(123 as any)).toThrow("non-empty string");
  });

  it("should create middleware function", () => {
    const middleware = createWebhookMiddleware(TEST_SECRET);
    expect(typeof middleware).toBe("function");
    expect(middleware.length).toBe(3); // Express middleware signature
  });

  it("should accept valid webhook request", async () => {
    const payload = createTestPayload();
    const signature = await generateWebhookSignature(payload, TEST_SECRET);
    const rawBody = JSON.stringify(payload);

    const req = createMockRequest(Buffer.from(rawBody), {
      "x-stellarsplit-signature": signature,
      "x-stellarsplit-timestamp": String(payload.timestamp),
      "x-stellarsplit-nonce": payload.nonce,
    });
    const res = createMockResponse();
    const next = createMockNext();

    const middleware = createWebhookMiddleware(TEST_SECRET);
    await middleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(isWebhookRequest(req as Request)).toBe(true);
    
    const webhookReq = req as WebhookRequest;
    expect(webhookReq.webhookPayload).toEqual(payload);
    expect(webhookReq.rawWebhookBody).toBe(rawBody);
  });

  it("should reject request with missing signature header", async () => {
    const payload = createTestPayload();
    const rawBody = JSON.stringify(payload);

    const req = createMockRequest(Buffer.from(rawBody), {
      "x-stellarsplit-timestamp": String(payload.timestamp),
      "x-stellarsplit-nonce": payload.nonce,
    });
    const res = createMockResponse();
    const next = createMockNext();

    const middleware = createWebhookMiddleware(TEST_SECRET);
    await middleware(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "MissingHeaderError",
      }),
    );
  });

  it("should reject request with missing timestamp header", async () => {
    const payload = createTestPayload();
    const signature = await generateWebhookSignature(payload, TEST_SECRET);
    const rawBody = JSON.stringify(payload);

    const req = createMockRequest(Buffer.from(rawBody), {
      "x-stellarsplit-signature": signature,
      "x-stellarsplit-nonce": payload.nonce,
    });
    const res = createMockResponse();
    const next = createMockNext();

    const middleware = createWebhookMiddleware(TEST_SECRET);
    await middleware(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "MissingHeaderError",
      }),
    );
  });

  it("should reject request with missing nonce header", async () => {
    const payload = createTestPayload();
    const signature = await generateWebhookSignature(payload, TEST_SECRET);
    const rawBody = JSON.stringify(payload);

    const req = createMockRequest(Buffer.from(rawBody), {
      "x-stellarsplit-signature": signature,
      "x-stellarsplit-timestamp": String(payload.timestamp),
    });
    const res = createMockResponse();
    const next = createMockNext();

    const middleware = createWebhookMiddleware(TEST_SECRET);
    await middleware(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "MissingHeaderError",
      }),
    );
  });

  it("should reject request with invalid signature", async () => {
    const payload = createTestPayload();
    const rawBody = JSON.stringify(payload);
    const invalidSignature = "0".repeat(64);

    const req = createMockRequest(Buffer.from(rawBody), {
      "x-stellarsplit-signature": invalidSignature,
      "x-stellarsplit-timestamp": String(payload.timestamp),
      "x-stellarsplit-nonce": payload.nonce,
    });
    const res = createMockResponse();
    const next = createMockNext();

    const middleware = createWebhookMiddleware(TEST_SECRET);
    await middleware(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "InvalidSignatureError",
      }),
    );
  });

  it("should reject request with timestamp outside tolerance", async () => {
    const oldTimestamp = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    const payload: WebhookPayload = {
      event: "invoice.paid",
      timestamp: oldTimestamp,
      nonce: `nonce_${Date.now()}`,
      data: { test: true },
    };
    const signature = await generateWebhookSignature(payload, TEST_SECRET);
    const rawBody = JSON.stringify(payload);

    const req = createMockRequest(Buffer.from(rawBody), {
      "x-stellarsplit-signature": signature,
      "x-stellarsplit-timestamp": String(oldTimestamp),
      "x-stellarsplit-nonce": payload.nonce,
    });
    const res = createMockResponse();
    const next = createMockNext();

    const middleware = createWebhookMiddleware(TEST_SECRET, {
      toleranceSeconds: 300, // 5 minutes
    });
    await middleware(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "TimestampOutOfBoundsError",
      }),
    );
  });

  it("should accept request with timestamp within tolerance", async () => {
    const recentTimestamp = Math.floor(Date.now() / 1000) - 60; // 1 minute ago
    const payload: WebhookPayload = {
      event: "invoice.paid",
      timestamp: recentTimestamp,
      nonce: `nonce_${Date.now()}`,
      data: { test: true },
    };
    const signature = await generateWebhookSignature(payload, TEST_SECRET);
    const rawBody = JSON.stringify(payload);

    const req = createMockRequest(Buffer.from(rawBody), {
      "x-stellarsplit-signature": signature,
      "x-stellarsplit-timestamp": String(recentTimestamp),
      "x-stellarsplit-nonce": payload.nonce,
    });
    const res = createMockResponse();
    const next = createMockNext();

    const middleware = createWebhookMiddleware(TEST_SECRET, {
      toleranceSeconds: 300,
    });
    await middleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("should reject replayed request (same nonce)", async () => {
    const payload = createTestPayload();
    const signature = await generateWebhookSignature(payload, TEST_SECRET);
    const rawBody = JSON.stringify(payload);

    const headers = {
      "x-stellarsplit-signature": signature,
      "x-stellarsplit-timestamp": String(payload.timestamp),
      "x-stellarsplit-nonce": payload.nonce,
    };

    const middleware = createWebhookMiddleware(TEST_SECRET);

    // First request should succeed
    const req1 = createMockRequest(Buffer.from(rawBody), headers);
    const res1 = createMockResponse();
    const next1 = createMockNext();

    await middleware(req1 as Request, res1 as Response, next1);
    expect(next1).toHaveBeenCalledOnce();

    // Second request with same nonce should be rejected
    const req2 = createMockRequest(Buffer.from(rawBody), headers);
    const res2 = createMockResponse();
    const next2 = createMockNext();

    await middleware(req2 as Request, res2 as Response, next2);
    expect(next2).not.toHaveBeenCalled();
    expect(res2.status).toHaveBeenCalledWith(400);
    expect(res2.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "ReplayAttackError",
      }),
    );
  });

  it("should accept multiple requests with different nonces", async () => {
    const middleware = createWebhookMiddleware(TEST_SECRET);

    for (let i = 0; i < 3; i++) {
      const payload = createTestPayload();
      const signature = await generateWebhookSignature(payload, TEST_SECRET);
      const rawBody = JSON.stringify(payload);

      const req = createMockRequest(Buffer.from(rawBody), {
        "x-stellarsplit-signature": signature,
        "x-stellarsplit-timestamp": String(payload.timestamp),
        "x-stellarsplit-nonce": payload.nonce,
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req as Request, res as Response, next);
      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    }
  });

  it("should handle malformed JSON payload", async () => {
    const rawBody = "{ invalid json }";
    const signature = await generateWebhookSignature(
      { event: "test" } as any,
      TEST_SECRET,
    );

    const req = createMockRequest(Buffer.from(rawBody), {
      "x-stellarsplit-signature": signature,
      "x-stellarsplit-timestamp": String(Math.floor(Date.now() / 1000)),
      "x-stellarsplit-nonce": "test-nonce",
    });
    const res = createMockResponse();
    const next = createMockNext();

    const middleware = createWebhookMiddleware(TEST_SECRET);
    await middleware(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("should handle body as string", async () => {
    const payload = createTestPayload();
    const signature = await generateWebhookSignature(payload, TEST_SECRET);
    const rawBody = JSON.stringify(payload);

    const req = createMockRequest(rawBody, {
      "x-stellarsplit-signature": signature,
      "x-stellarsplit-timestamp": String(payload.timestamp),
      "x-stellarsplit-nonce": payload.nonce,
    });
    const res = createMockResponse();
    const next = createMockNext();

    const middleware = createWebhookMiddleware(TEST_SECRET);
    await middleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("should handle body as parsed object", async () => {
    const payload = createTestPayload();
    const signature = await generateWebhookSignature(payload, TEST_SECRET);

    const req = createMockRequest(payload, {
      "x-stellarsplit-signature": signature,
      "x-stellarsplit-timestamp": String(payload.timestamp),
      "x-stellarsplit-nonce": payload.nonce,
    });
    const res = createMockResponse();
    const next = createMockNext();

    const middleware = createWebhookMiddleware(TEST_SECRET);
    await middleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("should validate payload structure", async () => {
    const invalidPayload = {
      // Missing required fields
      timestamp: Math.floor(Date.now() / 1000),
    };
    const signature = await generateWebhookSignature(invalidPayload as any, TEST_SECRET);
    const rawBody = JSON.stringify(invalidPayload);

    const req = createMockRequest(Buffer.from(rawBody), {
      "x-stellarsplit-signature": signature,
      "x-stellarsplit-timestamp": String(invalidPayload.timestamp),
      "x-stellarsplit-nonce": "test-nonce",
    });
    const res = createMockResponse();
    const next = createMockNext();

    const middleware = createWebhookMiddleware(TEST_SECRET);
    await middleware(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "InvalidPayloadError",
      }),
    );
  });

  it("should verify nonce matches between header and payload", async () => {
    const payload = createTestPayload();
    const signature = await generateWebhookSignature(payload, TEST_SECRET);
    const rawBody = JSON.stringify(payload);

    const req = createMockRequest(Buffer.from(rawBody), {
      "x-stellarsplit-signature": signature,
      "x-stellarsplit-timestamp": String(payload.timestamp),
      "x-stellarsplit-nonce": "different-nonce", // Mismatch
    });
    const res = createMockResponse();
    const next = createMockNext();

    const middleware = createWebhookMiddleware(TEST_SECRET);
    await middleware(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("should respect custom header names", async () => {
    const payload = createTestPayload();
    const signature = await generateWebhookSignature(payload, TEST_SECRET);
    const rawBody = JSON.stringify(payload);

    const req = createMockRequest(Buffer.from(rawBody), {
      "x-custom-signature": signature,
      "x-custom-timestamp": String(payload.timestamp),
      "x-custom-nonce": payload.nonce,
    });
    const res = createMockResponse();
    const next = createMockNext();

    const middleware = createWebhookMiddleware(TEST_SECRET, {
      signatureHeader: "x-custom-signature",
      timestampHeader: "x-custom-timestamp",
      nonceHeader: "x-custom-nonce",
    });
    await middleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledOnce();
  });
});

// ============================================================================
// Utility Function Tests
// ============================================================================

describe("isValidEventType", () => {
  it("should return true for valid event types", () => {
    expect(isValidEventType("invoice.created")).toBe(true);
    expect(isValidEventType("invoice.paid")).toBe(true);
    expect(isValidEventType("invoice.failed")).toBe(true);
    expect(isValidEventType("invoice.released")).toBe(true);
    expect(isValidEventType("invoice.refunded")).toBe(true);
    expect(isValidEventType("invoice.cancelled")).toBe(true);
    expect(isValidEventType("invoice.expired")).toBe(true);
  });

  it("should return false for invalid event types", () => {
    expect(isValidEventType("invoice.invalid")).toBe(false);
    expect(isValidEventType("payment.received")).toBe(false);
    expect(isValidEventType("")).toBe(false);
    expect(isValidEventType("INVOICE.PAID")).toBe(false);
  });
});

describe("parseWebhookPayload", () => {
  it("should parse valid payload", () => {
    const payload = createTestPayload();
    const rawPayload = JSON.stringify(payload);

    const parsed = parseWebhookPayload(rawPayload);
    expect(parsed).toEqual(payload);
  });

  it("should throw on invalid JSON", () => {
    expect(() => parseWebhookPayload("{ invalid }")).toThrow(InvalidPayloadError);
  });

  it("should throw on missing event field", () => {
    const invalid = { timestamp: 123, nonce: "abc", data: {} };
    expect(() => parseWebhookPayload(JSON.stringify(invalid))).toThrow(
      InvalidPayloadError,
    );
  });

  it("should throw on invalid event type", () => {
    const invalid = {
      event: "invalid.event",
      timestamp: 123,
      nonce: "abc",
      data: {},
    };
    expect(() => parseWebhookPayload(JSON.stringify(invalid))).toThrow(
      InvalidPayloadError,
    );
  });

  it("should throw on missing timestamp", () => {
    const invalid = { event: "invoice.paid", nonce: "abc", data: {} };
    expect(() => parseWebhookPayload(JSON.stringify(invalid))).toThrow(
      InvalidPayloadError,
    );
  });

  it("should throw on missing nonce", () => {
    const invalid = { event: "invoice.paid", timestamp: 123, data: {} };
    expect(() => parseWebhookPayload(JSON.stringify(invalid))).toThrow(
      InvalidPayloadError,
    );
  });

  it("should throw on missing data", () => {
    const invalid = { event: "invoice.paid", timestamp: 123, nonce: "abc" };
    expect(() => parseWebhookPayload(JSON.stringify(invalid))).toThrow(
      InvalidPayloadError,
    );
  });
});

describe("isWebhookRequest", () => {
  it("should return true for webhook request", () => {
    const req: Partial<WebhookRequest> = {
      webhookPayload: createTestPayload(),
      rawWebhookBody: "{}",
    };
    expect(isWebhookRequest(req as Request)).toBe(true);
  });

  it("should return false for regular request", () => {
    const req: Partial<Request> = {
      body: {},
    };
    expect(isWebhookRequest(req as Request)).toBe(false);
  });
});

// ============================================================================
// LRU Cache Behavior Tests
// ============================================================================

describe("LRU Cache (via middleware)", () => {
  it("should evict oldest nonce when cache is full", async () => {
    const middleware = createWebhookMiddleware(TEST_SECRET, {
      nonceWindowSize: 2, // Very small cache
    });

    // Send 3 requests with different nonces
    const nonces = ["nonce1", "nonce2", "nonce3"];

    for (const nonce of nonces) {
      const payload: WebhookPayload = {
        event: "invoice.paid",
        timestamp: Math.floor(Date.now() / 1000),
        nonce,
        data: { test: true },
      };
      const signature = await generateWebhookSignature(payload, TEST_SECRET);
      const rawBody = JSON.stringify(payload);

      const req = createMockRequest(Buffer.from(rawBody), {
        "x-stellarsplit-signature": signature,
        "x-stellarsplit-timestamp": String(payload.timestamp),
        "x-stellarsplit-nonce": nonce,
      });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware(req as Request, res as Response, next);
      expect(next).toHaveBeenCalled();
    }

    // Try to replay the first nonce (should succeed because it was evicted)
    const firstPayload: WebhookPayload = {
      event: "invoice.paid",
      timestamp: Math.floor(Date.now() / 1000),
      nonce: nonces[0]!,
      data: { test: true },
    };
    const signature = await generateWebhookSignature(firstPayload, TEST_SECRET);
    const rawBody = JSON.stringify(firstPayload);

    const req = createMockRequest(Buffer.from(rawBody), {
      "x-stellarsplit-signature": signature,
      "x-stellarsplit-timestamp": String(firstPayload.timestamp),
      "x-stellarsplit-nonce": nonces[0]!,
    });
    const res = createMockResponse();
    const next = createMockNext();

    await middleware(req as Request, res as Response, next);
    expect(next).toHaveBeenCalled(); // Should succeed (was evicted)
  });
});
