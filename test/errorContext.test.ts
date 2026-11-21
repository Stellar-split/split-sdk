import { describe, it, expect, beforeEach } from "vitest";
import {
  attachErrorContext,
  getErrorContext,
  hasErrorContext,
  sanitizeContext,
  mergeContext,
  serializeError,
  serializeErrorContext,
  createErrorContext,
  withErrorContext,
  wrapError,
  ERROR_CONTEXT_SYMBOL,
  ErrorContextStore,
} from "../src/errorContext.js";
import { StellarSplitError, InvoiceNotFoundError } from "../src/errors.js";
import { addBreadcrumb, clearBreadcrumbs } from "../src/breadcrumbTracker.js";

describe("Issue #1071 — Error Context", () => {
  beforeEach(() => {
    clearBreadcrumbs();
  });

  describe("Context Attachment", () => {
    it("attaches context to standard Error instances and retrieves it", () => {
      const err = new Error("Payment execution failed");
      expect(hasErrorContext(err)).toBe(false);

      attachErrorContext(err, {
        operation: "pay",
        invoiceId: "inv-42",
        network: "testnet",
      });

      expect(hasErrorContext(err)).toBe(true);
      const ctx = getErrorContext(err);
      expect(ctx).toBeDefined();
      expect(ctx?.operation).toBe("pay");
      expect(ctx?.invoiceId).toBe("inv-42");
      expect(ctx?.network).toBe("testnet");
      expect(ctx?.timestamp).toBeGreaterThan(0);
      expect((err as unknown as Record<string, unknown>).context).toBeDefined();
      expect((err as unknown as Record<symbol, unknown>)[ERROR_CONTEXT_SYMBOL]).toBeDefined();
    });

    it("attaches context to StellarSplitError instances and merges with existing context", () => {
      const err = new InvoiceNotFoundError("inv-99");
      expect(err.context).toEqual({ invoiceId: "inv-99" });

      attachErrorContext(err, {
        operation: "getInvoice",
        accountId: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        tags: { env: "staging" },
      });

      const ctx = getErrorContext(err);
      expect(ctx?.invoiceId).toBe("inv-99");
      expect(ctx?.operation).toBe("getInvoice");
      expect(ctx?.accountId).toBe("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
      expect(ctx?.tags).toEqual({ env: "staging" });
    });
  });

  describe("Utilities: Sanitization, Merge & Serialization", () => {
    it("sanitizeContext masks Stellar secret seeds and credential keys", () => {
      const sensitiveData = {
        seed: "SBVD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        apiKey: "sk_live_1234567890",
        nested: {
          userPassword: "SuperSecretPassword123!",
          authToken: "bearer xyz-token",
          publicAddress: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        },
        description: "Sent from account using secret SBVD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 for auth",
      };

      const sanitized = sanitizeContext(sensitiveData);

      expect(sanitized.seed).toBe("***MASKED***");
      expect(sanitized.apiKey).toBe("***MASKED***");
      expect(sanitized.nested.userPassword).toBe("***MASKED***");
      expect(sanitized.nested.authToken).toBe("***MASKED***");
      expect(sanitized.nested.publicAddress).toBe("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
      expect(sanitized.description).toContain("S***[MASKED]");
    });

    it("sanitizeContext safely handles BigInt and circular references without crashing", () => {
      const circular: Record<string, unknown> = {
        amount: 5000000000n,
      };
      circular.loop = circular;

      const sanitized = sanitizeContext(circular);

      expect(sanitized.amount).toBe("5000000000");
      expect(sanitized.loop).toBe("[Circular]");
    });

    it("mergeContext combines tags, extra, and breadcrumbs", () => {
      const base = {
        operation: "batchPay",
        tags: { region: "us-east" },
        extra: { step: 1 },
        breadcrumbs: [{ id: "bc-1", timestamp: 100, category: "http", message: "req 1" }],
      };

      const overlay = {
        invoiceId: "inv-1",
        tags: { tier: "premium" },
        extra: { step: 2, retried: true },
        breadcrumbs: [{ id: "bc-2", timestamp: 200, category: "rpc", message: "rpc 1" }],
      };

      const merged = mergeContext(base, overlay);

      expect(merged.operation).toBe("batchPay");
      expect(merged.invoiceId).toBe("inv-1");
      expect(merged.tags).toEqual({ region: "us-east", tier: "premium" });
      expect(merged.extra).toEqual({ step: 2, retried: true });
      expect(merged.breadcrumbs).toHaveLength(2);
      expect(merged.breadcrumbs?.map((b) => b.id)).toEqual(["bc-1", "bc-2"]);
    });

    it("serializeError produces a pure JSON-serializable object", () => {
      const circular: Record<string, unknown> = { amount: 1000n };
      circular.self = circular;

      const err = new StellarSplitError("Soroban contract failure", "CONTRACT_PANIC", circular, "raw-panic-str");
      const serialized = serializeError(err);

      expect(serialized.name).toBe("StellarSplitError");
      expect(serialized.message).toBe("Soroban contract failure");
      expect(serialized.code).toBe("CONTRACT_PANIC");
      expect(serialized.raw).toBe("raw-panic-str");
      expect(serialized.timestamp).toBeGreaterThan(0);

      // Must be safely JSON serializable with zero errors
      const json = JSON.stringify(serialized);
      expect(typeof json).toBe("string");
      const parsed = JSON.parse(json);
      expect(parsed.context.amount).toBe("1000");
      expect(parsed.context.self).toBe("[Circular]");
    });

    it("serializeErrorContext serializes context directly to JSON string", () => {
      const jsonStr = serializeErrorContext({
        operation: "createInvoice",
        extra: { balance: 999999999999999999n },
      });

      expect(jsonStr).toContain('"operation":"createInvoice"');
      expect(jsonStr).toContain('"balance":"999999999999999999"');
    });
  });

  describe("Helpers: ErrorContextBuilder & withErrorContext", () => {
    it("ErrorContextBuilder fluently constructs and attaches context", () => {
      addBreadcrumb({ category: "ui", message: "Step 1 click" });
      addBreadcrumb({ category: "rpc", message: "Step 2 send" });

      const err = new Error("Failed during execution");
      createErrorContext()
        .withOperation("closeRound")
        .withInvoiceId("inv-round-1")
        .withAccountId("GA...")
        .withNetwork("public")
        .withTag("component", "roundManager")
        .withExtra("roundEnd", 1800000000)
        .includeCurrentBreadcrumbs()
        .attachTo(err);

      const ctx = getErrorContext(err);
      expect(ctx?.operation).toBe("closeRound");
      expect(ctx?.invoiceId).toBe("inv-round-1");
      expect(ctx?.tags?.component).toBe("roundManager");
      expect(ctx?.extra?.roundEnd).toBe(1800000000);
      expect(ctx?.breadcrumbs).toHaveLength(2);
    });

    it("withErrorContext automatically decorates synchronous errors", () => {
      expect(() => {
        withErrorContext({ operation: "syncCalc", invoiceId: "inv-calc" }, () => {
          throw new Error("Division by zero");
        });
      }).toThrow("Division by zero");

      try {
        withErrorContext({ operation: "syncCalc", invoiceId: "inv-calc" }, () => {
          throw new Error("Division by zero");
        });
      } catch (e) {
        const ctx = getErrorContext(e);
        expect(ctx?.operation).toBe("syncCalc");
        expect(ctx?.invoiceId).toBe("inv-calc");
      }
    });

    it("withErrorContext automatically decorates asynchronous rejected promises", async () => {
      await expect(
        withErrorContext({ operation: "asyncFetch", network: "testnet" }, async () => {
          throw new Error("Horizon offline");
        })
      ).rejects.toThrow("Horizon offline");

      try {
        await withErrorContext({ operation: "asyncFetch", network: "testnet" }, async () => {
          throw new Error("Horizon offline");
        });
      } catch (e) {
        const ctx = getErrorContext(e);
        expect(ctx?.operation).toBe("asyncFetch");
        expect(ctx?.network).toBe("testnet");
      }
    });

    it("wrapError creates a StellarSplitError wrapping another error with context", () => {
      const original = new Error("Connection refused");
      const wrapped = wrapError(original, "Failed to submit invoice", {
        operation: "submitInvoice",
        invoiceId: "inv-wrap-1",
      });

      expect(wrapped).toBeInstanceOf(StellarSplitError);
      expect(wrapped.message).toContain("Failed to submit invoice: Connection refused");
      expect(wrapped.context?.operation).toBe("submitInvoice");
      expect(wrapped.context?.invoiceId).toBe("inv-wrap-1");
    });
  });

  describe("Context tracking and queries", () => {
    it("stores sanitized contexts and queries them through indexed dimensions", () => {
      const store = new ErrorContextStore(2);
      const first = new Error("RPC unavailable");
      attachErrorContext(first, { operation: "pay", invoiceId: "inv-1", extra: { secret: "do-not-store" } });
      store.capture(first);
      store.capture(new Error("other failure"), { operation: "refund", invoiceId: "inv-2" });

      const results = store.query({ operation: "pay" });
      expect(results).toHaveLength(1);
      expect(results[0]?.context.invoiceId).toBe("inv-1");
      expect(results[0]?.context.extra?.secret).toBe("***MASKED***");
      expect(results[0]?.error.stack).toContain("Error: RPC unavailable");

      store.capture(new Error("newest"), { operation: "pay", invoiceId: "inv-3" });
      expect(store.size()).toBe(2);
      expect(store.query({ invoiceId: "inv-1" })).toHaveLength(0);
    });
  });
});
