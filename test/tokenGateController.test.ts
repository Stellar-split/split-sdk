import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TokenGateController } from "../src/tokenGateController.js";
import { TokenGateAccessDeniedError } from "../src/errors.js";
import type { TokenGatePolicy } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const CALLER = "GCZST3XVCDTUJ76ZAV2HA72KYTZ4KXX52HRXVWWRWXH2NBDXZWQS2FB2";
const USDC_POLICY: TokenGatePolicy = {
  asset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  minBalance: "10.0000000",
  strict: true,
};

/**
 * Build a mock `_fetchBalance` implementation that returns `balance` for
 * the given `accountId` and `asset`.
 */
function mockFetchBalance(balance: string) {
  return vi.fn().mockResolvedValue(balance);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TokenGateController", () => {
  let controller: TokenGateController;

  beforeEach(() => {
    controller = new TokenGateController({
      horizonUrl: HORIZON_URL,
      cacheTtlMs: 5_000,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    controller.clearCache();
  });

  // ── Balance above minimum ────────────────────────────────────────────────

  describe("balance above minimum", () => {
    it("resolves when caller balance meets the requirement", async () => {
      vi.spyOn(controller as any, "_fetchBalance").mockResolvedValue("25.0000000");

      const result = await controller.verify(CALLER, USDC_POLICY);

      expect(result.allowed).toBe(true);
      expect(result.actualBalance).toBe("25.0000000");
      expect(result.requiredBalance).toBe("10.0000000");
      expect(result.cached).toBe(false);
    });

    it("resolves when caller balance exactly equals the minimum", async () => {
      vi.spyOn(controller as any, "_fetchBalance").mockResolvedValue("10.0000000");

      const result = await controller.verify(CALLER, USDC_POLICY);

      expect(result.allowed).toBe(true);
    });
  });

  // ── Balance below minimum ────────────────────────────────────────────────

  describe("balance below minimum (strict mode)", () => {
    it("throws TokenGateAccessDeniedError when balance is insufficient", async () => {
      vi.spyOn(controller as any, "_fetchBalance").mockResolvedValue("1.5000000");

      await expect(controller.verify(CALLER, USDC_POLICY)).rejects.toThrow(
        TokenGateAccessDeniedError,
      );
    });

    it("error includes the caller account ID and balance info", async () => {
      vi.spyOn(controller as any, "_fetchBalance").mockResolvedValue("0.0000000");

      let error: TokenGateAccessDeniedError | null = null;
      try {
        await controller.verify(CALLER, USDC_POLICY);
      } catch (e) {
        error = e as TokenGateAccessDeniedError;
      }

      expect(error).not.toBeNull();
      expect(error!.callerAccountId).toBe(CALLER);
      expect(error!.required).toBe("10.0000000");
      expect(error!.actual).toBe("0.0000000");
      expect(error!.assetCode).toBe("USDC");
    });
  });

  // ── Non-strict mode ──────────────────────────────────────────────────────

  describe("non-strict mode", () => {
    it("warns but does NOT throw when strict is false and balance is low", async () => {
      vi.spyOn(controller as any, "_fetchBalance").mockResolvedValue("0.5000000");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const nonStrictPolicy: TokenGatePolicy = {
        ...USDC_POLICY,
        strict: false,
      };

      const result = await controller.verify(CALLER, nonStrictPolicy);

      expect(result.allowed).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Non-strict warning"));
    });
  });

  // ── Caching ──────────────────────────────────────────────────────────────

  describe("balance check caching", () => {
    it("caches the result and skips Horizon on second call", async () => {
      const fetchSpy = vi
        .spyOn(controller as any, "_fetchBalance")
        .mockResolvedValue("50.0000000");

      // First call — hits Horizon
      const first = await controller.verify(CALLER, USDC_POLICY);
      expect(first.cached).toBe(false);

      // Second call — served from cache
      const second = await controller.verify(CALLER, USDC_POLICY);
      expect(second.cached).toBe(true);

      // Horizon should only have been called once
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("re-fetches after cache is invalidated", async () => {
      const fetchSpy = vi
        .spyOn(controller as any, "_fetchBalance")
        .mockResolvedValue("30.0000000");

      await controller.verify(CALLER, USDC_POLICY);
      controller.invalidateCache(CALLER, USDC_POLICY);
      await controller.verify(CALLER, USDC_POLICY);

      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("re-fetches after clearCache()", async () => {
      const fetchSpy = vi
        .spyOn(controller as any, "_fetchBalance")
        .mockResolvedValue("20.0000000");

      await controller.verify(CALLER, USDC_POLICY);
      controller.clearCache();
      await controller.verify(CALLER, USDC_POLICY);

      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("caches even failed (access-denied) results to avoid hammering Horizon", async () => {
      const fetchSpy = vi
        .spyOn(controller as any, "_fetchBalance")
        .mockResolvedValue("0.0000000");

      // First attempt — hits Horizon and throws
      await expect(controller.verify(CALLER, USDC_POLICY)).rejects.toThrow(
        TokenGateAccessDeniedError,
      );

      // Second attempt — cache hit, still throws but no new Horizon call
      await expect(controller.verify(CALLER, USDC_POLICY)).rejects.toThrow(
        TokenGateAccessDeniedError,
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ── Native / XLM asset ───────────────────────────────────────────────────

  describe("native XLM policy", () => {
    it("resolves when caller has enough XLM", async () => {
      const fetchSpy = vi
        .spyOn(controller as any, "_fetchBalance")
        .mockResolvedValue("100.0000000");

      const xlmPolicy: TokenGatePolicy = {
        asset: "native",
        minBalance: "50.0000000",
      };

      const result = await controller.verify(CALLER, xlmPolicy);

      expect(result.allowed).toBe(true);
      expect(fetchSpy).toHaveBeenCalledWith(CALLER, "native");
    });
  });

  // ── Error code ───────────────────────────────────────────────────────────

  describe("TokenGateAccessDeniedError", () => {
    it("has the correct error code", async () => {
      vi.spyOn(controller as any, "_fetchBalance").mockResolvedValue("0.0000000");

      let err: TokenGateAccessDeniedError | null = null;
      try {
        await controller.verify(CALLER, USDC_POLICY);
      } catch (e) {
        err = e as TokenGateAccessDeniedError;
      }

      expect(err?.code).toBe("TOKEN_GATE_ACCESS_DENIED");
      expect(err?.name).toBe("TokenGateAccessDeniedError");
    });
  });
});
