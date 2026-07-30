/**
 * Unit tests for AccountSignerWeightCalculator (#477)
 *
 * Covers:
 * - Sufficient weight (both keys provided, medThreshold: 2 → totalWeight 3)
 * - Insufficient weight (only G1, weight 1 vs medThreshold 2 → missingWeight 1)
 * - Cache hit on second call within 30s
 * - Cache bypass after TTL expiry
 * - InsufficientSignerWeightError includes { provided, totalWeight, required }
 * - Master key only
 * - Wrong threshold level (low vs high)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair, Horizon } from "@stellar/stellar-sdk";
import { AccountSignerWeightCalculator } from "../src/accounts/AccountSignerWeightCalculator.js";
import { InsufficientSignerWeightError } from "../src/errors.js";

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

const G1 = Keypair.random().publicKey();
const G2 = Keypair.random().publicKey();
const MASTER = Keypair.random().publicKey();

/** Create a minimal AccountResponse stub. */
function makeAccountStub(
  signers: Array<{ key: string; weight: number; type: string }>,
  thresholds: { low_threshold: number; med_threshold: number; high_threshold: number },
): Horizon.AccountResponse {
  return {
    id: MASTER,
    account_id: MASTER,
    sequence: "0",
    subentry_count: 0,
    inflation_destination: undefined,
    home_domain: "",
    last_modified_ledger: 0,
    last_modified_time: "",
    thresholds,
    flags: { auth_required: false, auth_revocable: false, auth_immutable: false, auth_clawback_enabled: false },
    balances: [],
    signers,
    data: {},
    paging_token: "",
    _links: {} as any,
    _embedded: {} as any,
  } as unknown as Horizon.AccountResponse;
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe("AccountSignerWeightCalculator (#477)", () => {
  let loadAccountMock: ReturnType<typeof vi.fn>;
  let calculator: AccountSignerWeightCalculator;

  beforeEach(() => {
    loadAccountMock = vi.fn();
    // @ts-expect-error
    Horizon.Server.prototype.loadAccount = loadAccountMock;
    // Use 30s TTL (default)
    calculator = new AccountSignerWeightCalculator("http://localhost:8000");
  });

  // -------------------------------------------------------------------------
  // Sufficient weight
  // -------------------------------------------------------------------------

  it("returns sufficient: true when both G1 (w=1) and G2 (w=2) are provided with medThreshold=2", async () => {
    const stub = makeAccountStub(
      [
        { key: G1, weight: 1, type: "ed25519_public_key" },
        { key: G2, weight: 2, type: "ed25519_public_key" },
      ],
      { low_threshold: 0, med_threshold: 2, high_threshold: 3 },
    );
    loadAccountMock.mockResolvedValue(stub);

    const result = await calculator.calculateWeight(MASTER, [G1, G2], "medium");

    expect(result.sufficient).toBe(true);
    expect(result.totalWeight).toBe(3);
    expect(result.missingWeight).toBe(0);
    expect(result.requiredThreshold).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Insufficient weight
  // -------------------------------------------------------------------------

  it("returns sufficient: false with missingWeight=1 when only G1 (w=1) is provided vs medThreshold=2", async () => {
    const stub = makeAccountStub(
      [
        { key: G1, weight: 1, type: "ed25519_public_key" },
        { key: G2, weight: 2, type: "ed25519_public_key" },
      ],
      { low_threshold: 0, med_threshold: 2, high_threshold: 3 },
    );
    loadAccountMock.mockResolvedValue(stub);

    const result = await calculator.calculateWeight(MASTER, [G1], "medium");

    expect(result.sufficient).toBe(false);
    expect(result.totalWeight).toBe(1);
    expect(result.missingWeight).toBe(1);
    expect(result.requiredThreshold).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Master key only
  // -------------------------------------------------------------------------

  it("correctly accounts for master key weight when only master key is provided", async () => {
    const stub = makeAccountStub(
      [{ key: MASTER, weight: 5, type: "ed25519_public_key" }],
      { low_threshold: 0, med_threshold: 3, high_threshold: 5 },
    );
    loadAccountMock.mockResolvedValue(stub);

    const lowResult = await calculator.calculateWeight(MASTER, [MASTER], "low");
    expect(lowResult.sufficient).toBe(true);

    // Re-fetch hits cache, so loadAccount still called once
    const highResult = await calculator.calculateWeight(MASTER, [MASTER], "high");
    expect(highResult.sufficient).toBe(true);
    expect(loadAccountMock).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Cache hit
  // -------------------------------------------------------------------------

  it("uses the cached account record for a second call within 30 seconds", async () => {
    const stub = makeAccountStub(
      [{ key: G1, weight: 3, type: "ed25519_public_key" }],
      { low_threshold: 1, med_threshold: 2, high_threshold: 3 },
    );
    loadAccountMock.mockResolvedValue(stub);

    await calculator.calculateWeight(MASTER, [G1], "medium");
    await calculator.calculateWeight(MASTER, [G1], "high");

    // loadAccount should only be called once due to cache
    expect(loadAccountMock).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Cache bypass after expiry
  // -------------------------------------------------------------------------

  it("re-fetches the account after the cache TTL expires", async () => {
    const stub = makeAccountStub(
      [{ key: G1, weight: 2, type: "ed25519_public_key" }],
      { low_threshold: 0, med_threshold: 1, high_threshold: 2 },
    );
    loadAccountMock.mockResolvedValue(stub);

    // Use a 10ms TTL for this test
    const shortCalculator = new AccountSignerWeightCalculator("http://localhost:8000", 10);
    // @ts-expect-error
    Horizon.Server.prototype.loadAccount = loadAccountMock;

    await shortCalculator.calculateWeight(MASTER, [G1], "medium");
    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 20));
    await shortCalculator.calculateWeight(MASTER, [G1], "medium");

    expect(loadAccountMock).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // InsufficientSignerWeightError payload
  // -------------------------------------------------------------------------

  it("assertSufficientWeight throws InsufficientSignerWeightError with { provided, totalWeight, required }", async () => {
    const stub = makeAccountStub(
      [
        { key: G1, weight: 1, type: "ed25519_public_key" },
        { key: G2, weight: 3, type: "ed25519_public_key" },
      ],
      { low_threshold: 0, med_threshold: 3, high_threshold: 5 },
    );
    loadAccountMock.mockResolvedValue(stub);

    let caught: unknown;
    try {
      await calculator.assertSufficientWeight(MASTER, [G1], "medium");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(InsufficientSignerWeightError);
    const err = caught as InsufficientSignerWeightError;
    expect(err.provided).toEqual([G1]);
    expect(err.totalWeight).toBe(1);
    expect(err.required).toBe(3);
    expect(err.code).toBe("INSUFFICIENT_SIGNER_WEIGHT");
  });

  // -------------------------------------------------------------------------
  // Threshold levels
  // -------------------------------------------------------------------------

  it("uses the correct threshold for each level (low/medium/high)", async () => {
    const stub = makeAccountStub(
      [{ key: G1, weight: 2, type: "ed25519_public_key" }],
      { low_threshold: 1, med_threshold: 2, high_threshold: 5 },
    );
    loadAccountMock.mockResolvedValue(stub);

    const low = await calculator.calculateWeight(MASTER, [G1], "low");
    expect(low.sufficient).toBe(true);
    expect(low.requiredThreshold).toBe(1);

    const med = await calculator.calculateWeight(MASTER, [G1], "medium");
    expect(med.sufficient).toBe(true);
    expect(med.requiredThreshold).toBe(2);

    const high = await calculator.calculateWeight(MASTER, [G1], "high");
    expect(high.sufficient).toBe(false);
    expect(high.requiredThreshold).toBe(5);
    expect(high.missingWeight).toBe(3);
  });
});
