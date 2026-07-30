/**
 * Tests for SubentryCapacityGuard — Issue #591
 *
 * Covers all acceptance criteria:
 *  1. checkSubentryCapacity returns the correct {available, used, limit, canAccommodate}
 *     from live Horizon account data.
 *  2. Sponsored subentries (num_sponsoring / num_sponsored) are correctly factored in.
 *  3. When canAccommodate is false, splitExecutor throws SubentryCapacityGuardError
 *     that names the specific account ID and additional reserve XLM needed.
 *  4. Callers can opt out with { skipCapacityCheck: true }, bypassing the guard.
 *
 * All Horizon.Server interactions are replaced with vi.spyOn mocks — no
 * network calls are made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Horizon } from "@stellar/stellar-sdk";
import {
  checkSubentryCapacity,
  SubentryCapacityGuardError,
} from "../src/account/subentryGuard.js";
import {
  splitExecutor,
} from "../src/payments/splitExecutor.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const ACCOUNT_ID = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const ACCOUNT_ID_2 = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPGQS7Z5H4M3I5K6XTLCPUDVKL";

/** One base reserve in XLM (0.5 XLM = 5_000_000 stroops). */
const BASE_RESERVE_XLM = 0.5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal Horizon.AccountResponse-compatible mock.
 *
 * @param xlmBalance     - Native XLM balance as a string (e.g. "10.0000000").
 * @param subentryCount  - Number of subentries currently on the account.
 * @param numSponsoring  - Number of entries the account is sponsoring for others.
 * @param numSponsored   - Number of the account's entries that are sponsored by others.
 */
function makeAccount(opts: {
  xlmBalance: string;
  subentryCount: number;
  numSponsoring?: number;
  numSponsored?: number;
}) {
  const {
    xlmBalance,
    subentryCount,
    numSponsoring = 0,
    numSponsored = 0,
  } = opts;

  return {
    subentry_count: subentryCount,
    num_sponsoring: numSponsoring,
    num_sponsored: numSponsored,
    balances: [
      {
        asset_type: "native" as const,
        balance: xlmBalance,
        buying_liabilities: "0.0000000",
        selling_liabilities: "0.0000000",
      },
    ],
    // Stub out the rest of AccountResponse to satisfy the type
    account_id: ACCOUNT_ID,
    sequence: "1000",
    signers: [],
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    sequenceNumber: () => "1000",
  } as unknown as Horizon.AccountResponse;
}

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

let loadAccountSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  loadAccountSpy = vi.spyOn(Horizon.Server.prototype, "loadAccount");
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// checkSubentryCapacity — unit tests
// ---------------------------------------------------------------------------

describe("checkSubentryCapacity", () => {
  // -------------------------------------------------------------------------
  // AC-1: Well-funded account with plenty of free slots
  // -------------------------------------------------------------------------
  it("returns correct capacity for a well-funded account", async () => {
    /*
     * Setup: 10 XLM balance, 2 subentries, no sponsoring/sponsored.
     *
     * Locked reserve = (2 + 2 + 0 − 0) × 0.5 XLM = 2.0 XLM = 20_000_000 stroops
     * Free balance   = 10 XLM − 2 XLM = 8 XLM = 80_000_000 stroops
     * Available slots = 80_000_000 ÷ 5_000_000 = 16
     * Used            = 2 (subentry_count)
     * Limit           = 2 + 16 = 18
     * canAccommodate  = 16 >= 1 → true
     */
    loadAccountSpy.mockResolvedValueOnce(
      makeAccount({ xlmBalance: "10.0000000", subentryCount: 2 }),
    );

    const result = await checkSubentryCapacity(ACCOUNT_ID, 1, HORIZON_URL);

    expect(result.used).toBe(2);
    expect(result.available).toBe(16);
    expect(result.limit).toBe(18);
    expect(result.canAccommodate).toBe(true);
  });

  // -------------------------------------------------------------------------
  // AC-2a: Account exactly at capacity (0 free slots)
  // -------------------------------------------------------------------------
  it("throws SubentryCapacityGuardError when account is exactly at capacity", async () => {
    /*
     * Setup: 1.0 XLM balance, 0 subentries, no sponsoring/sponsored.
     *
     * Locked reserve = (2 + 0 + 0 − 0) × 0.5 XLM = 1.0 XLM = 10_000_000 stroops
     * Free balance   = 1.0 XLM − 1.0 XLM = 0 stroops
     * Available slots = 0 ÷ 5_000_000 = 0
     * canAccommodate  = 0 >= 1 → false  → throws
     */
    loadAccountSpy.mockResolvedValueOnce(
      makeAccount({ xlmBalance: "1.0000000", subentryCount: 0 }),
    );

    await expect(
      checkSubentryCapacity(ACCOUNT_ID, 1, HORIZON_URL),
    ).rejects.toThrow(SubentryCapacityGuardError);
  });

  it("SubentryCapacityGuardError names the account ID and reserve needed", async () => {
    loadAccountSpy.mockResolvedValueOnce(
      makeAccount({ xlmBalance: "1.0000000", subentryCount: 0 }),
    );

    let caughtError: SubentryCapacityGuardError | null = null;
    try {
      await checkSubentryCapacity(ACCOUNT_ID, 1, HORIZON_URL);
    } catch (err) {
      if (err instanceof SubentryCapacityGuardError) {
        caughtError = err;
      }
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError!.accountId).toBe(ACCOUNT_ID);
    // Shortfall: 1 slot × 5_000_000 stroops = 5_000_000 stroops
    expect(caughtError!.additionalReserveNeededStroops).toBe(5_000_000n);
    expect(caughtError!.additionalReserveNeededXlm).toBe("0.5000000");
    expect(caughtError!.capacityResult.canAccommodate).toBe(false);
  });

  // -------------------------------------------------------------------------
  // AC-2b: Account with enough balance for exactly the requested slots
  // -------------------------------------------------------------------------
  it("returns canAccommodate: true when balance covers exactly the requested slots", async () => {
    /*
     * Setup: 1.5 XLM balance, 0 subentries, no sponsoring/sponsored.
     *
     * Locked reserve = (2 + 0) × 0.5 XLM = 1.0 XLM
     * Free balance   = 0.5 XLM = 5_000_000 stroops
     * Available slots = 5_000_000 ÷ 5_000_000 = 1
     * canAccommodate  = 1 >= 1 → true
     */
    loadAccountSpy.mockResolvedValueOnce(
      makeAccount({ xlmBalance: "1.5000000", subentryCount: 0 }),
    );

    const result = await checkSubentryCapacity(ACCOUNT_ID, 1, HORIZON_URL);

    expect(result.used).toBe(0);
    expect(result.available).toBe(1);
    expect(result.limit).toBe(1);
    expect(result.canAccommodate).toBe(true);
  });

  // -------------------------------------------------------------------------
  // AC-3: Sponsored subentries — num_sponsoring and num_sponsored
  // -------------------------------------------------------------------------
  it("correctly accounts for sponsored subentries (num_sponsoring increases reserve)", async () => {
    /*
     * Setup: 10 XLM balance, 2 subentries, sponsoring 3 others, sponsored 0.
     *
     * Effective subentries = 2 + 3 − 0 = 5
     * Locked reserve = (2 + 5) × 0.5 XLM = 3.5 XLM = 35_000_000 stroops
     * Free balance   = 10 XLM − 3.5 XLM = 6.5 XLM = 65_000_000 stroops
     * Available slots = 65_000_000 ÷ 5_000_000 = 13
     */
    loadAccountSpy.mockResolvedValueOnce(
      makeAccount({
        xlmBalance: "10.0000000",
        subentryCount: 2,
        numSponsoring: 3,
        numSponsored: 0,
      }),
    );

    const result = await checkSubentryCapacity(ACCOUNT_ID, 1, HORIZON_URL);

    expect(result.used).toBe(2);
    expect(result.available).toBe(13);
    expect(result.canAccommodate).toBe(true);
  });

  it("correctly accounts for sponsored subentries (num_sponsored reduces reserve)", async () => {
    /*
     * Setup: 10 XLM balance, 4 subentries, sponsoring 0, sponsored 2.
     *
     * Effective subentries = 4 + 0 − 2 = 2
     * Locked reserve = (2 + 2) × 0.5 XLM = 2.0 XLM = 20_000_000 stroops
     * Free balance   = 10 XLM − 2 XLM = 8 XLM = 80_000_000 stroops
     * Available slots = 80_000_000 ÷ 5_000_000 = 16
     */
    loadAccountSpy.mockResolvedValueOnce(
      makeAccount({
        xlmBalance: "10.0000000",
        subentryCount: 4,
        numSponsoring: 0,
        numSponsored: 2,
      }),
    );

    const result = await checkSubentryCapacity(ACCOUNT_ID, 1, HORIZON_URL);

    // Sponsored entries free up reserve — more slots available than raw count suggests.
    expect(result.used).toBe(4);
    expect(result.available).toBe(16);
    expect(result.canAccommodate).toBe(true);
  });

  it("throws when a sponsored account still cannot afford the required slots", async () => {
    /*
     * Setup: 1.0 XLM balance, 2 subentries, sponsored 2 by someone else.
     *
     * Effective subentries = 2 + 0 − 2 = 0
     * Locked reserve = (2 + 0) × 0.5 XLM = 1.0 XLM = 10_000_000 stroops
     * Free balance   = 1.0 XLM − 1.0 XLM = 0
     * Available slots = 0 → throws for 1 required slot
     */
    loadAccountSpy.mockResolvedValueOnce(
      makeAccount({
        xlmBalance: "1.0000000",
        subentryCount: 2,
        numSponsoring: 0,
        numSponsored: 2,
      }),
    );

    await expect(
      checkSubentryCapacity(ACCOUNT_ID, 1, HORIZON_URL),
    ).rejects.toThrow(SubentryCapacityGuardError);
  });
});

// ---------------------------------------------------------------------------
// splitExecutor — integration tests
// ---------------------------------------------------------------------------

describe("splitExecutor", () => {
  // -------------------------------------------------------------------------
  // AC-4: skip-flag bypass path
  // -------------------------------------------------------------------------
  it("skips the capacity check when skipCapacityCheck: true is passed", async () => {
    // loadAccount should NOT be called when the flag is set.
    loadAccountSpy.mockRejectedValue(new Error("Should not have been called"));

    const result = await splitExecutor(
      [{ address: ACCOUNT_ID, amount: 1_000_000n }],
      { skipCapacityCheck: true, horizonUrl: HORIZON_URL },
    );

    expect(result.success).toBe(true);
    expect(result.skippedCapacityCheck).toBe(true);
    expect(result.capacityChecks).toEqual({});
    // loadAccount was never invoked.
    expect(loadAccountSpy).not.toHaveBeenCalled();
  });

  it("runs capacity checks and succeeds for a well-funded account", async () => {
    loadAccountSpy.mockResolvedValue(
      makeAccount({ xlmBalance: "20.0000000", subentryCount: 2 }),
    );

    const result = await splitExecutor(
      [{ address: ACCOUNT_ID, amount: 5_000_000n, requiredSlots: 1 }],
      { horizonUrl: HORIZON_URL },
    );

    expect(result.success).toBe(true);
    expect(result.skippedCapacityCheck).toBe(false);
    expect(result.capacityChecks[ACCOUNT_ID]).toBeDefined();
    expect(result.capacityChecks[ACCOUNT_ID].canAccommodate).toBe(true);
  });

  it("throws SubentryCapacityGuardError for a recipient at capacity", async () => {
    // Exactly at capacity — 1.0 XLM with 0 subentries
    loadAccountSpy.mockResolvedValue(
      makeAccount({ xlmBalance: "1.0000000", subentryCount: 0 }),
    );

    await expect(
      splitExecutor(
        [{ address: ACCOUNT_ID, amount: 5_000_000n, requiredSlots: 1 }],
        { horizonUrl: HORIZON_URL },
      ),
    ).rejects.toThrow(SubentryCapacityGuardError);
  });

  it("names the failing account ID in the thrown error", async () => {
    loadAccountSpy.mockResolvedValue(
      makeAccount({ xlmBalance: "1.0000000", subentryCount: 0 }),
    );

    let caughtError: SubentryCapacityGuardError | null = null;
    try {
      await splitExecutor(
        [{ address: ACCOUNT_ID, amount: 5_000_000n, requiredSlots: 1 }],
        { horizonUrl: HORIZON_URL },
      );
    } catch (err) {
      if (err instanceof SubentryCapacityGuardError) {
        caughtError = err;
      }
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError!.accountId).toBe(ACCOUNT_ID);
    expect(caughtError!.additionalReserveNeededStroops).toBeGreaterThan(0n);
  });

  it("checks all recipients sequentially and throws on the first failing one", async () => {
    // First recipient: well-funded
    // Second recipient: exactly at capacity
    loadAccountSpy
      .mockResolvedValueOnce(
        makeAccount({ xlmBalance: "20.0000000", subentryCount: 2 }),
      )
      .mockResolvedValueOnce(
        makeAccount({ xlmBalance: "1.0000000", subentryCount: 0 }),
      );

    let caughtError: SubentryCapacityGuardError | null = null;
    try {
      await splitExecutor(
        [
          { address: ACCOUNT_ID, amount: 5_000_000n, requiredSlots: 1 },
          { address: ACCOUNT_ID_2, amount: 5_000_000n, requiredSlots: 1 },
        ],
        { horizonUrl: HORIZON_URL },
      );
    } catch (err) {
      if (err instanceof SubentryCapacityGuardError) {
        caughtError = err;
      }
    }

    expect(caughtError).not.toBeNull();
    // Error should reference the SECOND account (the one at capacity)
    expect(caughtError!.accountId).toBe(ACCOUNT_ID_2);
  });

  it("defaults requiredSlots to 1 when not provided", async () => {
    loadAccountSpy.mockResolvedValue(
      makeAccount({ xlmBalance: "20.0000000", subentryCount: 2 }),
    );

    const result = await splitExecutor(
      // No requiredSlots field
      [{ address: ACCOUNT_ID, amount: 5_000_000n }],
      { horizonUrl: HORIZON_URL },
    );

    expect(result.success).toBe(true);
    expect(loadAccountSpy).toHaveBeenCalledOnce();
  });
});
