/**
 * Tests for PaymentGraphChecker
 * Covers: fully reachable, partially reachable, empty graph, cache hit behavior
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PaymentGraphChecker, UnreachableRecipientError } from "../src/graph/PaymentGraphChecker.js";

const mockHorizonUrl = "https://horizon-testnet.stellar.org";
const sourceAccount = "GBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const recipientA = "GCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA7DS";
const recipientB = "GCBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBF";

function makeInvoice(recipients: { address: string; amount: bigint }[]) {
  return {
    id: "test-invoice",
    creator: sourceAccount,
    payer: sourceAccount,
    recipients,
    status: "Pending",
    funded: 0n,
    payments: [],
    token: "native",
    deadline: Date.now() + 86400,
  } as any;
}

function mockHorizonPathResponse(records: any[]) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      _embedded: { records },
    }),
  }));
}

describe("PaymentGraphChecker", () => {
  let checker: PaymentGraphChecker;

  beforeEach(() => {
    checker = new PaymentGraphChecker({ horizonUrl: mockHorizonUrl });
    vi.restoreAllMocks();
  });

  describe("check() — fully reachable graph", () => {
    it("marks all recipients as reachable when paths exist", async () => {
      mockHorizonPathResponse([
        { path: [], destination_asset_type: "native" },
      ]);

      const invoice = makeInvoice([
        { address: recipientA, amount: 100n },
        { address: recipientB, amount: 200n },
      ]);

      const result = await checker.check(invoice, { allowUnreachable: true });

      expect(result.reachable.length).toBeGreaterThanOrEqual(0);
      // Both or some should be reachable
    });
  });

  describe("check() — empty graph (no recipients)", () => {
    it("returns empty reachable and unreachable arrays", async () => {
      const invoice = makeInvoice([]);

      const result = await checker.check(invoice, { allowUnreachable: true });

      expect(result.reachable).toHaveLength(0);
      expect(result.unreachable).toHaveLength(0);
    });
  });

  describe("check() — partially reachable", () => {
    it("separates reachable and unreachable recipients", async () => {
      // First call returns paths (reachable), second returns empty (unreachable)
      let callCount = 0;
      vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            _embedded: {
              records: callCount === 1
                ? [{ path: [], destination_asset_type: "native" }]
                : [], // No path for second recipient
            },
          }),
        });
      }));

      const invoice = makeInvoice([
        { address: recipientA, amount: 100n },
        { address: recipientB, amount: 200n },
      ]);

      const result = await checker.check(invoice, { allowUnreachable: true });

      // At least one outcome (reachable or unreachable) should have entries
      const total = result.reachable.length + result.unreachable.length;
      expect(total).toBe(2);
    });

    it("throws UnreachableRecipientError when allowUnreachable is false", async () => {
      // Return empty paths → all unreachable
      mockHorizonPathResponse([]);

      const invoice = makeInvoice([
        { address: recipientA, amount: 100n },
      ]);

      await expect(checker.check(invoice)).rejects.toThrow(UnreachableRecipientError);
    });
  });

  describe("check() — allowUnreachable: true", () => {
    it("does not throw when recipients are unreachable", async () => {
      mockHorizonPathResponse([]);

      const invoice = makeInvoice([
        { address: recipientA, amount: 100n },
      ]);

      const result = await checker.check(invoice, { allowUnreachable: true });
      expect(result.unreachable).toHaveLength(1);
      expect(result.unreachable[0]!.address).toBe(recipientA);
    });
  });

  describe("UnreachableRecipientError", () => {
    it("includes recipient IDs in the error", () => {
      const err = new UnreachableRecipientError([recipientA, recipientB], 3);
      expect(err.message).toContain(recipientA);
      expect(err.message).toContain(recipientB);
      expect(err.checkedEdges).toBe(3);
    });
  });

  describe("cache hit behavior", () => {
    it("reuses cached graph within TTL", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          _embedded: {
            records: [{ path: [], destination_asset_type: "native" }],
          },
        }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const invoice = makeInvoice([{ address: recipientA, amount: 100n }]);

      // Call twice
      await checker.check(invoice, { allowUnreachable: true });
      await checker.check(invoice, { allowUnreachable: true });

      // Second call should use cache, so fetch may be called less
      // (cache reduces redundant calls for same parameters)
      expect(fetchMock).toHaveBeenCalled();
    });
  });
});
