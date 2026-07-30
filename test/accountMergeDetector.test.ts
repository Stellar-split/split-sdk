/**
 * Tests for AccountMergeDetector
 * Covers: merge detection, rerouting, recursive merge chain, invalid destination rejection
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AccountMergeDetector, InvalidDestinationError } from "../src/accounts/AccountMergeDetector.js";

describe("AccountMergeDetector", () => {
  const horizonUrl = "https://horizon-testnet.stellar.org";
  let detector: AccountMergeDetector;

  beforeEach(() => {
    // Create detector with a minimal mock client
    const mockClient = {} as any;
    detector = new AccountMergeDetector(mockClient, horizonUrl);
  });

  describe("watchAccount", () => {
    it("adds and removes accounts from watch list", () => {
      const account = "GBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
      detector.watchAccount(account);
      detector.unwatchAccount(account);
      // Should not throw
    });
  });

  describe("resolveMergeDestination", () => {
    it("returns the original account if not merged", async () => {
      const account = "GBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
      const resolved = await detector.resolveMergeDestination(account);
      expect(resolved).toBe(account);
    });

    it("resolves to the destination when account was merged", async () => {
      const source = "GBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
      const dest = "GCBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBF";

      // Manually set cache to simulate detected merge
      (detector as any).mergeCache.set(source, dest);

      const resolved = await detector.resolveMergeDestination(source);
      expect(resolved).toBe(dest);
    });

    it("recursively resolves merge chains up to depth 5", async () => {
      const a = "GAAAAA";
      const b = "GBBBBB";
      const c = "GCCCCC";

      (detector as any).mergeCache.set(a, b);
      (detector as any).mergeCache.set(b, c);

      const resolved = await detector.resolveMergeDestination(a);
      expect(resolved).toBe(c);
    });

    it("throws when merge chain exceeds depth 5", async () => {
      // Create a chain: a -> b -> c -> d -> e -> f (depth 6)
      const chain = ["GA", "GB", "GC", "GD", "GE", "GF", "GG"];
      for (let i = 0; i < chain.length - 1; i++) {
        (detector as any).mergeCache.set(chain[i], chain[i + 1]);
      }

      await expect(detector.resolveMergeDestination(chain[0]!)).rejects.toThrow(
        /too deep/
      );
    });
  });

  describe("validateDestination", () => {
    it("throws InvalidDestinationError when account does not exist", async () => {
      const nonExistentAccount = "GNON_EXISTENT";
      
      // Mock fetch to return 404
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ error: "not found" }),
      }));

      await expect(
        detector.validateDestination(nonExistentAccount)
      ).rejects.toThrow(InvalidDestinationError);

      vi.unstubAllGlobals();
    });

    it("throws InvalidDestinationError when destination is itself merged", async () => {
      const dest = "GCBBBBB";

      // Mock that destination was also merged
      (detector as any).mergeCache.set(dest, "GCCCCC");

      // Mock fetch to return 200 (account exists)
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ balances: [] }),
      }));

      await expect(
        detector.validateDestination(dest)
      ).rejects.toThrow(InvalidDestinationError);

      vi.unstubAllGlobals();
    });

    it("throws when required trustline is missing", async () => {
      const dest = "GCBBBBB";

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          balances: [{ asset_type: "native", balance: "100.0" }],
        }),
      }));

      await expect(
        detector.validateDestination(dest, { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" })
      ).rejects.toThrow(InvalidDestinationError);

      vi.unstubAllGlobals();
    });

    it("succeeds when account exists with required trustline", async () => {
      const dest = "GCBBBBB";
      const issuer = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          balances: [
            { asset_code: "USDC", asset_issuer: issuer, balance: "100.0" },
          ],
        }),
      }));

      await expect(
        detector.validateDestination(dest, { code: "USDC", issuer })
      ).resolves.not.toThrow();

      vi.unstubAllGlobals();
    });
  });

  describe("emit events", () => {
    it("emits recipient:mergeDetected when merge is detected", async () => {
      const events: any[] = [];
      detector.on("recipient:mergeDetected", (evt) => events.push(evt));

      const source = "GBAAAAA";
      const destination = "GCBBBBB";

      // Trigger handleMergeDetected directly via the private method
      await (detector as any).handleMergeDetected(source, destination, {
        created_at: new Date().toISOString(),
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ sourceAccount: source, destinationAccount: destination });
    });
  });
});
