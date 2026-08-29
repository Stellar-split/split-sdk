/**
 * Tests for RecipientBalancePreCheck (#484)
 *
 * All Horizon.Server interactions are replaced with vi.spyOn mocks so no
 * network calls are made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Horizon } from "@stellar/stellar-sdk";
import {
  RecipientBalancePreCheck,
} from "../src/preflight/RecipientBalancePreCheck.js";
import type { PreCheckResult } from "../src/preflight/RecipientBalancePreCheck.js";
import { RecipientPreCheckFailedError } from "../src/errors.js";

// ---------------------------------------------------------------------------
// Helpers / fixtures
// ---------------------------------------------------------------------------

const ADDR_VALID = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const ADDR_MISSING = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPGQS7Z5H4M3I5K6XTLCPUDVKL";

const ASSET_CODE = "USDC";
const ASSET_ISSUER = "GDQOE23CFSUMSVQK4Y5JHPPYK73VYCNHZHA7ENKCV37P6SUEO6XQBKPP";

/** Build a minimal AccountResponse-compatible mock object. */
function makeAccount(
  opts: {
    sequence?: string;
    subentryCount?: number;
    xlmBalance?: string;
    trustlines?: Array<{ code: string; issuer: string; balance?: string }>;
  } = {},
) {
  const {
    sequence = "1000",
    subentryCount = 2,
    xlmBalance = "10.0000000",
    trustlines = [],
  } = opts;

  const balances: Horizon.HorizonApi.BalanceLine[] = [
    {
      asset_type: "native" as const,
      balance: xlmBalance,
      buying_liabilities: "0.0000000",
      selling_liabilities: "0.0000000",
    } as Horizon.HorizonApi.BalanceLineNative,
    ...trustlines.map(
      (t) =>
        ({
          asset_type: "credit_alphanum4" as const,
          asset_code: t.code,
          asset_issuer: t.issuer,
          balance: t.balance ?? "100.0000000",
          limit: "922337203685.4775807",
          buying_liabilities: "0.0000000",
          selling_liabilities: "0.0000000",
          last_modified_ledger: 12345,
          is_authorized: true,
          is_authorized_to_maintain_liabilities: true,
          is_clawback_enabled: false,
        }) as Horizon.HorizonApi.BalanceLineAsset,
    ),
  ];

  return {
    sequenceNumber: () => sequence,
    subentry_count: subentryCount,
    balances,
  };
}

// ---------------------------------------------------------------------------
// Setup — spy on Horizon.Server.prototype.loadAccount
// ---------------------------------------------------------------------------

let loadAccountSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  loadAccountSpy = vi.spyOn(
    Horizon.Server.prototype,
    "loadAccount",
  ) as ReturnType<typeof vi.spyOn>;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RecipientBalancePreCheck — account_exists", () => {
  it("returns passed: false when account does not exist", async () => {
    loadAccountSpy.mockRejectedValue(new Error("Not Found"));

    const checker = new RecipientBalancePreCheck();
    const [result] = await checker.run([ADDR_MISSING]);

    expect(result!.passed).toBe(false);
    const accountCheck = result!.checks.find((c) => c.name === "account_exists");
    expect(accountCheck!.passed).toBe(false);
    expect(result!.remediations.length).toBeGreaterThan(0);
    expect(result!.remediations[0]).toMatch(/fund account/i);
  });

  it("skips subsequent checks when account does not exist", async () => {
    loadAccountSpy.mockRejectedValue(new Error("Not Found"));

    const checker = new RecipientBalancePreCheck({
      assetCode: ASSET_CODE,
      assetIssuer: ASSET_ISSUER,
    });
    const [result] = await checker.run([ADDR_MISSING]);

    // Only the account_exists check should be present
    expect(result!.checks).toHaveLength(1);
    expect(result!.checks[0]!.name).toBe("account_exists");
  });
});

describe("RecipientBalancePreCheck — trustline_present", () => {
  it("returns trustline_present: false when trustline is missing", async () => {
    loadAccountSpy.mockResolvedValue(makeAccount({ subentryCount: 1, xlmBalance: "5.0000000" }) as any);

    const checker = new RecipientBalancePreCheck({
      assetCode: ASSET_CODE,
      assetIssuer: ASSET_ISSUER,
    });
    const [result] = await checker.run([ADDR_VALID]);

    const tlCheck = result!.checks.find((c) => c.name === "trustline_present");
    expect(tlCheck!.passed).toBe(false);
    expect(result!.remediations.some((r) => r.includes("trustline"))).toBe(true);
  });

  it("returns trustline_present: true when correct trustline exists", async () => {
    loadAccountSpy.mockResolvedValue(
      makeAccount({
        trustlines: [{ code: ASSET_CODE, issuer: ASSET_ISSUER }],
      }) as any,
    );

    const checker = new RecipientBalancePreCheck({
      assetCode: ASSET_CODE,
      assetIssuer: ASSET_ISSUER,
    });
    const [result] = await checker.run([ADDR_VALID]);

    const tlCheck = result!.checks.find((c) => c.name === "trustline_present");
    expect(tlCheck!.passed).toBe(true);
  });

  it("skips trustline check when no assetCode/assetIssuer given", async () => {
    loadAccountSpy.mockResolvedValue(makeAccount() as any);

    const checker = new RecipientBalancePreCheck();
    const [result] = await checker.run([ADDR_VALID]);

    const tlCheck = result!.checks.find((c) => c.name === "trustline_present");
    expect(tlCheck).toBeUndefined();
  });
});

describe("RecipientBalancePreCheck — minimum_reserve", () => {
  it("fails when native balance is below minimum reserve", async () => {
    // subentries=2  → reserve = (2+2)*0.5 = 2 XLM; balance = 1 XLM → shortfall 1 XLM
    loadAccountSpy.mockResolvedValue(
      makeAccount({ subentryCount: 2, xlmBalance: "1.0000000" }) as any,
    );

    const checker = new RecipientBalancePreCheck();
    const [result] = await checker.run([ADDR_VALID]);

    const reserveCheck = result!.checks.find((c) => c.name === "minimum_reserve");
    expect(reserveCheck!.passed).toBe(false);
    expect(result!.remediations.some((r) => r.includes("reserve"))).toBe(true);
    // Shortfall detail should mention XLM
    expect(reserveCheck!.detail).toMatch(/shortfall/i);
  });

  it("passes when native balance satisfies reserve", async () => {
    // subentries=2 → reserve = 2 XLM; balance = 10 XLM → ok
    loadAccountSpy.mockResolvedValue(
      makeAccount({ subentryCount: 2, xlmBalance: "10.0000000" }) as any,
    );

    const checker = new RecipientBalancePreCheck();
    const [result] = await checker.run([ADDR_VALID]);

    const reserveCheck = result!.checks.find((c) => c.name === "minimum_reserve");
    expect(reserveCheck!.passed).toBe(true);
  });

  it("includes exact XLM shortfall in the remediation hint", async () => {
    // reserve = (2+4)*0.5 = 3 XLM; balance = 1.5 → shortfall = 1.5 XLM
    loadAccountSpy.mockResolvedValue(
      makeAccount({ subentryCount: 4, xlmBalance: "1.5000000" }) as any,
    );

    const checker = new RecipientBalancePreCheck();
    const [result] = await checker.run([ADDR_VALID]);

    const hint = result!.remediations.find((r) => r.includes("reserve"));
    expect(hint).toBeDefined();
    expect(hint).toMatch(/1\.5/);
  });

  it("uses default skipThresholdXlm of 10 when not specified", async () => {
    // reserve = 2 XLM; balance = 12 XLM (exactly reserve + 10 XLM threshold)
    // Should trigger fast-path
    loadAccountSpy.mockResolvedValue(
      makeAccount({ subentryCount: 2, xlmBalance: "12.0000000" }) as any,
    );

    const debugSpy = vi.spyOn(console, "debug");
    const checker = new RecipientBalancePreCheck();
    const [result] = await checker.run([ADDR_VALID]);

    const reserveCheck = result!.checks.find((c) => c.name === "minimum_reserve");
    expect(reserveCheck!.passed).toBe(true);
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining("Fast-path skip"),
    );
    debugSpy.mockRestore();
  });

  it("skips detailed validation when balance exceeds reserve + skipThreshold", async () => {
    // reserve = 2 XLM; balance = 15 XLM; threshold = 5 XLM
    // 15 >= 2 + 5, so should trigger fast-path
    loadAccountSpy.mockResolvedValue(
      makeAccount({ subentryCount: 2, xlmBalance: "15.0000000" }) as any,
    );

    const debugSpy = vi.spyOn(console, "debug");
    const checker = new RecipientBalancePreCheck({ skipThresholdXlm: 5 });
    const [result] = await checker.run([ADDR_VALID]);

    const reserveCheck = result!.checks.find((c) => c.name === "minimum_reserve");
    expect(reserveCheck!.passed).toBe(true);
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining("threshold 5"),
    );
    debugSpy.mockRestore();
  });

  it("respects custom skipThresholdXlm option", async () => {
    // reserve = 2 XLM; balance = 11 XLM; threshold = 10 XLM
    // 11 < 2 + 10, so should NOT trigger fast-path
    loadAccountSpy.mockResolvedValue(
      makeAccount({ subentryCount: 2, xlmBalance: "11.0000000" }) as any,
    );

    const debugSpy = vi.spyOn(console, "debug");
    const checker = new RecipientBalancePreCheck({ skipThresholdXlm: 10 });
    const [result] = await checker.run([ADDR_VALID]);

    const reserveCheck = result!.checks.find((c) => c.name === "minimum_reserve");
    expect(reserveCheck!.passed).toBe(true);
    expect(debugSpy).not.toHaveBeenCalled();
    debugSpy.mockRestore();
  });

  it("does not skip when balance is only slightly above reserve", async () => {
    // reserve = 2 XLM; balance = 2.5 XLM; default threshold = 10 XLM
    // 2.5 < 2 + 10, so should NOT trigger fast-path
    loadAccountSpy.mockResolvedValue(
      makeAccount({ subentryCount: 2, xlmBalance: "2.5000000" }) as any,
    );

    const debugSpy = vi.spyOn(console, "debug");
    const checker = new RecipientBalancePreCheck();
    const [result] = await checker.run([ADDR_VALID]);

    const reserveCheck = result!.checks.find((c) => c.name === "minimum_reserve");
    expect(reserveCheck!.passed).toBe(true);
    expect(debugSpy).not.toHaveBeenCalled();
    debugSpy.mockRestore();
  });
});

describe("RecipientBalancePreCheck — fully valid recipient", () => {
  it("passes all four checks and returns remediations: []", async () => {
    loadAccountSpy.mockResolvedValue(
      makeAccount({
        subentryCount: 2,
        xlmBalance: "10.0000000",
        trustlines: [{ code: ASSET_CODE, issuer: ASSET_ISSUER }],
      }) as any,
    );

    const checker = new RecipientBalancePreCheck({
      assetCode: ASSET_CODE,
      assetIssuer: ASSET_ISSUER,
    });
    const [result] = await checker.run([ADDR_VALID]);

    expect(result!.passed).toBe(true);
    expect(result!.remediations).toHaveLength(0);
    expect(result!.checks.every((c) => c.passed)).toBe(true);
  });
});

describe("RecipientBalancePreCheck — multiple recipients", () => {
  it("returns one result per recipient", async () => {
    loadAccountSpy
      .mockResolvedValueOnce(makeAccount() as any)
      .mockRejectedValueOnce(new Error("Not Found"));

    const checker = new RecipientBalancePreCheck();
    const results = await checker.run([ADDR_VALID, ADDR_MISSING]);

    expect(results).toHaveLength(2);
    expect(results[0]!.recipient).toBe(ADDR_VALID);
    expect(results[1]!.recipient).toBe(ADDR_MISSING);
    expect(results[0]!.passed).toBe(true);
    expect(results[1]!.passed).toBe(false);
  });

  it("runAndGetFailing returns only failing recipients", async () => {
    loadAccountSpy
      .mockResolvedValueOnce(makeAccount() as any)
      .mockRejectedValueOnce(new Error("Not Found"));

    const checker = new RecipientBalancePreCheck();
    const failing = await checker.runAndGetFailing([ADDR_VALID, ADDR_MISSING]);

    expect(failing).toHaveLength(1);
    expect(failing[0]!.recipient).toBe(ADDR_MISSING);
  });
});

describe("RecipientPreCheckFailedError", () => {
  it("lists all failing recipients in the error message", () => {
    const fakeResult: PreCheckResult = {
      recipient: ADDR_MISSING,
      passed: false,
      checks: [
        { name: "account_exists", passed: false, detail: "not found" },
      ],
      remediations: ["Fund the account"],
    };

    const err = new RecipientPreCheckFailedError([fakeResult]);
    expect(err.code).toBe("RECIPIENT_PRE_CHECK_FAILED");
    expect(err.failingResults).toHaveLength(1);
    expect(err.message).toContain(ADDR_MISSING);
    expect(err.message).toContain("account_exists");
  });

  it("is instanceof StellarSplitError", async () => {
    const { StellarSplitError } = await import("../src/errors.js");
    const err = new RecipientPreCheckFailedError([]);
    expect(err).toBeInstanceOf(StellarSplitError);
  });
});
