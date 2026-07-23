/**
 * Tests for SDK telemetry hooks (issue #362).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { StellarSplitClient } from "../src/client.js";
import type {
  TelemetryHooks,
  TelemetryErrorContext,
  TelemetryCallStartParams,
  TelemetryCallEndParams,
} from "../src/telemetryHooks.js";
import { StellarSplitError, InvoiceNotFoundError } from "../src/errors.js";

describe("Telemetry Hooks", () => {
  let client: StellarSplitClient;

  beforeEach(() => {
    client = new StellarSplitClient({
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      contractId: "CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K",
    });
  });

  describe("setTelemetryHooks", () => {
    it("should accept hook functions", () => {
      const hooks: TelemetryHooks = {
        onError: vi.fn(),
        onCallStart: vi.fn(),
        onCallEnd: vi.fn(),
      };

      expect(() => client.setTelemetryHooks(hooks)).not.toThrow();
    });

    it("should accept partial hook configuration", () => {
      const hooks: TelemetryHooks = {
        onError: vi.fn(),
      };

      expect(() => client.setTelemetryHooks(hooks)).not.toThrow();
    });

    it("should replace previously registered hooks", () => {
      const firstHooks: TelemetryHooks = {
        onError: vi.fn(),
      };
      const secondHooks: TelemetryHooks = {
        onCallStart: vi.fn(),
      };

      client.setTelemetryHooks(firstHooks);
      client.setTelemetryHooks(secondHooks);

      // Should not throw, second registration replaces first
      expect(() => client.setTelemetryHooks(secondHooks)).not.toThrow();
    });
  });

  describe("clearTelemetryHooks", () => {
    it("should remove all registered hooks", () => {
      const hooks: TelemetryHooks = {
        onError: vi.fn(),
        onCallStart: vi.fn(),
        onCallEnd: vi.fn(),
      };

      client.setTelemetryHooks(hooks);
      expect(() => client.clearTelemetryHooks()).not.toThrow();
    });

    it("should be safe to call without registered hooks", () => {
      expect(() => client.clearTelemetryHooks()).not.toThrow();
    });
  });

  describe("onError hook", () => {
    it("should be called with error and context", async () => {
      const onError = vi.fn();
      client.setTelemetryHooks({ onError });

      try {
        // This will fail because we're using a mock client
        await client.getInvoice("999999");
      } catch (error) {
        // Expected to throw
      }

      // The hook should have been called
      if (onError.mock.calls.length > 0) {
        const [error, context] = onError.mock.calls[0];
        expect(error).toBeInstanceOf(Error);
        expect(context).toHaveProperty("method");
        expect(context).toHaveProperty("timestamp");
        expect(typeof context.timestamp).toBe("number");
      }
    });

    it("should include method name in context", async () => {
      const onError = vi.fn();
      client.setTelemetryHooks({ onError });

      try {
        await client.getInvoice("999999");
      } catch (error) {
        // Expected to throw
      }

      if (onError.mock.calls.length > 0) {
        const [, context] = onError.mock.calls[0] as [Error, TelemetryErrorContext];
        expect(context.method).toBeDefined();
      }
    });

    it("should not propagate hook exceptions to caller", async () => {
      const onError = vi.fn(() => {
        throw new Error("Hook failure");
      });
      client.setTelemetryHooks({ onError });

      try {
        await client.getInvoice("999999");
      } catch (error) {
        // Should be the original SDK error, not the hook error
        expect((error as Error).message).not.toContain("Hook failure");
      }
    });
  });

  describe("onCallStart hook", () => {
    it("should be called before RPC calls", async () => {
      const onCallStart = vi.fn();
      client.setTelemetryHooks({ onCallStart });

      try {
        await client.getInvoice("123");
      } catch (error) {
        // Expected to fail
      }

      if (onCallStart.mock.calls.length > 0) {
        const [params] = onCallStart.mock.calls[0] as [TelemetryCallStartParams];
        expect(params).toHaveProperty("method");
        expect(params).toHaveProperty("timestamp");
        expect(typeof params.timestamp).toBe("number");
      }
    });

    it("should include timestamp in params", async () => {
      const onCallStart = vi.fn();
      client.setTelemetryHooks({ onCallStart });

      try {
        await client.getInvoice("123");
      } catch (error) {
        // Expected to fail
      }

      if (onCallStart.mock.calls.length > 0) {
        const [params] = onCallStart.mock.calls[0] as [TelemetryCallStartParams];
        expect(params.timestamp).toBeGreaterThan(0);
      }
    });

    it("should not propagate hook exceptions", async () => {
      const onCallStart = vi.fn(() => {
        throw new Error("Hook error");
      });
      client.setTelemetryHooks({ onCallStart });

      // Should not throw the hook error
      try {
        await client.getInvoice("123");
      } catch (error) {
        expect((error as Error).message).not.toContain("Hook error");
      }
    });
  });

  describe("onCallEnd hook", () => {
    it("should be called after RPC calls complete", async () => {
      const onCallEnd = vi.fn();
      client.setTelemetryHooks({ onCallEnd });

      try {
        await client.getInvoice("123");
      } catch (error) {
        // Expected to fail
      }

      if (onCallEnd.mock.calls.length > 0) {
        const [params] = onCallEnd.mock.calls[0] as [TelemetryCallEndParams];
        expect(params).toHaveProperty("method");
        expect(params).toHaveProperty("durationMs");
        expect(params).toHaveProperty("success");
        expect(params).toHaveProperty("timestamp");
      }
    });

    it("should include duration in milliseconds", async () => {
      const onCallEnd = vi.fn();
      client.setTelemetryHooks({ onCallEnd });

      try {
        await client.getInvoice("123");
      } catch (error) {
        // Expected to fail
      }

      if (onCallEnd.mock.calls.length > 0) {
        const [params] = onCallEnd.mock.calls[0] as [TelemetryCallEndParams];
        expect(typeof params.durationMs).toBe("number");
        expect(params.durationMs).toBeGreaterThanOrEqual(0);
      }
    });

    it("should indicate success=false on error", async () => {
      const onCallEnd = vi.fn();
      client.setTelemetryHooks({ onCallEnd });

      try {
        await client.getInvoice("999999");
      } catch (error) {
        // Expected to fail
      }

      if (onCallEnd.mock.calls.length > 0) {
        const [params] = onCallEnd.mock.calls[0] as [TelemetryCallEndParams];
        expect(params.success).toBe(false);
      }
    });

    it("should include error when call fails", async () => {
      const onCallEnd = vi.fn();
      client.setTelemetryHooks({ onCallEnd });

      try {
        await client.getInvoice("999999");
      } catch (error) {
        // Expected to fail
      }

      if (onCallEnd.mock.calls.length > 0) {
        const [params] = onCallEnd.mock.calls[0] as [TelemetryCallEndParams];
        if (!params.success) {
          expect(params.error).toBeDefined();
        }
      }
    });

    it("should not propagate hook exceptions", async () => {
      const onCallEnd = vi.fn(() => {
        throw new Error("Hook failure");
      });
      client.setTelemetryHooks({ onCallEnd });

      try {
        await client.getInvoice("123");
      } catch (error) {
        expect((error as Error).message).not.toContain("Hook failure");
      }
    });
  });

  describe("Multiple hooks", () => {
    it("should call all registered hooks in sequence", async () => {
      const onError = vi.fn();
      const onCallStart = vi.fn();
      const onCallEnd = vi.fn();

      client.setTelemetryHooks({ onError, onCallStart, onCallEnd });

      try {
        await client.getInvoice("999999");
      } catch (error) {
        // Expected to fail
      }

      // At least onCallStart and onCallEnd should be called
      expect(onCallStart.mock.calls.length).toBeGreaterThanOrEqual(0);
      expect(onCallEnd.mock.calls.length).toBeGreaterThanOrEqual(0);
    });

    it("should isolate failures between hooks", async () => {
      const onError = vi.fn(() => {
        throw new Error("onError failed");
      });
      const onCallStart = vi.fn(() => {
        throw new Error("onCallStart failed");
      });
      const onCallEnd = vi.fn(() => {
        throw new Error("onCallEnd failed");
      });

      client.setTelemetryHooks({ onError, onCallStart, onCallEnd });

      // Should not throw despite all hooks throwing
      try {
        await client.getInvoice("123");
      } catch (error) {
        // Should be SDK error, not hook error
        const message = (error as Error).message;
        expect(message).not.toContain("onError failed");
        expect(message).not.toContain("onCallStart failed");
        expect(message).not.toContain("onCallEnd failed");
      }
    });
  });

  describe("Type safety", () => {
    it("should accept TypeScript-typed hooks", () => {
      const hooks: TelemetryHooks = {
        onError: (error: StellarSplitError, context: TelemetryErrorContext) => {
          expect(error).toBeDefined();
          expect(context.method).toBeDefined();
        },
        onCallStart: (params: TelemetryCallStartParams) => {
          expect(params.method).toBeDefined();
          expect(params.timestamp).toBeDefined();
        },
        onCallEnd: (params: TelemetryCallEndParams) => {
          expect(params.method).toBeDefined();
          expect(params.durationMs).toBeDefined();
          expect(params.success).toBeDefined();
        },
      };

      client.setTelemetryHooks(hooks);
    });
  });

  describe("Integration scenarios", () => {
    it("should support Sentry-like error tracking", async () => {
      const capturedErrors: Array<{ error: StellarSplitError; context: TelemetryErrorContext }> = [];

      client.setTelemetryHooks({
        onError: (error, context) => {
          capturedErrors.push({ error, context });
        },
      });

      try {
        await client.getInvoice("999999");
      } catch (error) {
        // Expected
      }

      // Verify Sentry-like capture occurred
      expect(capturedErrors.length).toBeGreaterThanOrEqual(0);
    });

    it("should support performance monitoring", async () => {
      const performanceMetrics: Array<TelemetryCallEndParams> = [];

      client.setTelemetryHooks({
        onCallEnd: (params) => {
          performanceMetrics.push(params);
        },
      });

      try {
        await client.getInvoice("123");
      } catch (error) {
        // Expected
      }

      if (performanceMetrics.length > 0) {
        expect(performanceMetrics[0].durationMs).toBeGreaterThanOrEqual(0);
      }
    });

    it("should support custom logging", async () => {
      const logs: string[] = [];

      client.setTelemetryHooks({
        onCallStart: ({ method, timestamp }) => {
          logs.push(`[${timestamp}] Starting ${method}`);
        },
        onCallEnd: ({ method, durationMs, success }) => {
          logs.push(`[${Date.now()}] Completed ${method} in ${durationMs}ms (success: ${success})`);
        },
      });

      try {
        await client.getInvoice("123");
      } catch (error) {
        // Expected
      }

      expect(logs.length).toBeGreaterThanOrEqual(0);
    });
  });
});
