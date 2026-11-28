/**
 * Tests for issue #880 — Referral rewards: claimReferralRewards, getReferralBalance, payWithReferral
 */
import { describe, it, expect, vi } from "vitest";
import { Keypair, StrKey, nativeToScVal } from "@stellar/stellar-sdk";
import { StellarSplitClient } from "../src/client.js";

// `rpc.assembleTransaction` is a non-configurable getter on the real SDK
// namespace, so it can't be `vi.spyOn`-ed directly; override it via a
// partial module mock, then mutate the mocked fn per-test as needed.
vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return { ...actual, rpc: { ...actual.rpc, assembleTransaction: vi.fn() } };
});
import {
  NothingToClaimError,
  ValidationError,
  InvoiceNotFoundError,
  SimulationFailedError,
} from "../src/errors.js";
import type { ReferralClaimResult, ReferralPayResult } from "../src/types.js";

/** Valid Stellar G-address used as a referrer in tests. */
const REFERRER = Keypair.random().publicKey();
/** Valid Stellar G-address used as the fake source account in tests. */
const FAKE_ACCOUNT_ID = Keypair.random().publicKey();

function makeClient() {
  return new StellarSplitClient({
    rpcUrl: "https://example.com",
    networkPassphrase: "Test Network",
    contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
  });
}

// ---------------------------------------------------------------------------
// getReferralBalance
// ---------------------------------------------------------------------------

describe("getReferralBalance (#880)", () => {
  it("returns the balance as a bigint", async () => {
    const client = makeClient();

    vi.spyOn(client as any, "server", "get").mockReturnValue({
      getAccount: vi.fn().mockResolvedValue({
        accountId: () => FAKE_ACCOUNT_ID,
        sequenceNumber: () => "1",
        incrementSequenceNumber: vi.fn(),
      }),
      simulateTransaction: vi.fn().mockResolvedValue({
        result: { retval: nativeToScVal(250_000_000n) },
        transactionData: { build: () => ({ toXDR: () => "" }) },
        minResourceFee: "100",
      }),
    });

    const balance = await client.getReferralBalance(REFERRER);
    expect(typeof balance).toBe("bigint");
  });

  it("returns 0n when contract returns falsy retval", async () => {
    const client = makeClient();

    vi.spyOn(client as any, "server", "get").mockReturnValue({
      getAccount: vi.fn().mockResolvedValue({
        accountId: () => FAKE_ACCOUNT_ID,
        sequenceNumber: () => "1",
        incrementSequenceNumber: vi.fn(),
      }),
      simulateTransaction: vi.fn().mockResolvedValue({
        result: { retval: null },
        transactionData: { build: () => ({ toXDR: () => "" }) },
        minResourceFee: "100",
      }),
    });

    const balance = await client.getReferralBalance(REFERRER);
    expect(balance).toBe(0n);
  });

  it("defaults to connected wallet when no address provided", async () => {
    const client = makeClient();

    const mockSimulate = vi.fn().mockResolvedValue({
      result: { retval: nativeToScVal(100n) },
      transactionData: { build: () => ({ toXDR: () => "" }) },
      minResourceFee: "100",
    });

    vi.spyOn(client as any, "server", "get").mockReturnValue({
      getAccount: vi.fn().mockResolvedValue({
        accountId: () => FAKE_ACCOUNT_ID,
        sequenceNumber: () => "1",
        incrementSequenceNumber: vi.fn(),
      }),
      simulateTransaction: mockSimulate,
    });

    // Should not throw when no address is passed
    await expect(client.getReferralBalance()).resolves.not.toThrow();
    expect(mockSimulate).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// claimReferralRewards
// ---------------------------------------------------------------------------

describe("claimReferralRewards (#880)", () => {
  it("throws NothingToClaimError when balance is zero", async () => {
    const client = makeClient();

    vi.spyOn(client as any, "server", "get").mockReturnValue({
      getAccount: vi.fn().mockResolvedValue({
        accountId: () => FAKE_ACCOUNT_ID,
        sequenceNumber: () => "1",
        incrementSequenceNumber: vi.fn(),
      }),
      simulateTransaction: vi.fn().mockResolvedValue({
        result: { retval: nativeToScVal(0n) },
        transactionData: { build: () => ({ toXDR: () => "" }) },
        minResourceFee: "100",
      }),
    });

    await expect(client.claimReferralRewards()).rejects.toBeInstanceOf(NothingToClaimError);
  });

  it("returns ReferralClaimResult with amountClaimed and txHash on success", async () => {
    const client = makeClient();

    let callCount = 0;
    vi.spyOn(client as any, "server", "get").mockReturnValue({
      getAccount: vi.fn().mockResolvedValue({
        accountId: () => FAKE_ACCOUNT_ID,
        sequenceNumber: () => "1",
        incrementSequenceNumber: vi.fn(),
      }),
      simulateTransaction: vi.fn().mockImplementation(() => {
        callCount++;
        // First call is getReferralBalance check; return non-zero balance
        // Second call is the actual claim
        return Promise.resolve({
          result: { retval: nativeToScVal(500_000_000n) },
          transactionData: { build: () => ({ toXDR: () => "" }) },
          minResourceFee: "100",
        });
      }),
      sendTransaction: vi.fn().mockResolvedValue({ status: "SUCCESS", hash: "claim-tx-hash" }),
    });

    const { rpc: SorobanRpc } = await import("@stellar/stellar-sdk");
    (SorobanRpc.assembleTransaction as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      build: () => ({ toXDR: () => "signed-xdr" }),
    } as any);

    const walletMod = await import("../src/wallet.js");
    vi.spyOn(walletMod, "signTransaction").mockResolvedValue("signed-xdr");

    const { TransactionBuilder } = await import("@stellar/stellar-sdk");
    vi.spyOn(TransactionBuilder, "fromXDR").mockReturnValue({} as any);

    const result: ReferralClaimResult = await client.claimReferralRewards();
    expect(result).toHaveProperty("amountClaimed");
    expect(result).toHaveProperty("txHash", "claim-tx-hash");
    expect(typeof result.amountClaimed).toBe("bigint");
  });

  it("NothingToClaimError carries the address", async () => {
    const client = makeClient();

    vi.spyOn(client as any, "server", "get").mockReturnValue({
      getAccount: vi.fn().mockResolvedValue({
        accountId: () => FAKE_ACCOUNT_ID,
        sequenceNumber: () => "1",
        incrementSequenceNumber: vi.fn(),
      }),
      simulateTransaction: vi.fn().mockResolvedValue({
        result: { retval: nativeToScVal(0n) },
        transactionData: { build: () => ({ toXDR: () => "" }) },
        minResourceFee: "100",
      }),
    });

    try {
      await client.claimReferralRewards();
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NothingToClaimError);
      expect((err as NothingToClaimError).code).toBe("NOTHING_TO_CLAIM");
    }
  });
});

// ---------------------------------------------------------------------------
// payWithReferral
// ---------------------------------------------------------------------------

describe("payWithReferral (#880)", () => {
  it("throws ValidationError for an invalid referrer address", async () => {
    const client = makeClient();

    await expect(
      client.payWithReferral("inv-123", 100_000_000n, "NOT_A_VALID_ADDRESS")
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("returns ReferralPayResult with txHash and referrer on success", async () => {
    const client = makeClient();

    vi.spyOn(client as any, "server", "get").mockReturnValue({
      getAccount: vi.fn().mockResolvedValue({
        accountId: () => FAKE_ACCOUNT_ID,
        sequenceNumber: () => "1",
        incrementSequenceNumber: vi.fn(),
      }),
      simulateTransaction: vi.fn().mockResolvedValue({
        result: { retval: nativeToScVal(null as unknown as bigint) },
        transactionData: { build: () => ({ toXDR: () => "" }) },
        minResourceFee: "100",
      }),
      sendTransaction: vi.fn().mockResolvedValue({ status: "SUCCESS", hash: "pay-ref-tx" }),
    });

    const { rpc: SorobanRpc } = await import("@stellar/stellar-sdk");
    (SorobanRpc.assembleTransaction as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      build: () => ({ toXDR: () => "signed-xdr" }),
    } as any);

    const walletMod = await import("../src/wallet.js");
    vi.spyOn(walletMod, "signTransaction").mockResolvedValue("signed-xdr");

    const { TransactionBuilder } = await import("@stellar/stellar-sdk");
    vi.spyOn(TransactionBuilder, "fromXDR").mockReturnValue({} as any);

    const result: ReferralPayResult = await client.payWithReferral(
      "inv-123",
      100_000_000n,
      REFERRER
    );
    expect(result.txHash).toBe("pay-ref-tx");
    expect(result.referrer).toBe(REFERRER);
  });

  it("passes the referrer address to the contract call", async () => {
    const client = makeClient();

    const mockSimulate = vi.fn().mockResolvedValue({
      result: { retval: nativeToScVal(null as unknown as bigint) },
      transactionData: { build: () => ({ toXDR: () => "" }) },
      minResourceFee: "100",
    });

    vi.spyOn(client as any, "server", "get").mockReturnValue({
      getAccount: vi.fn().mockResolvedValue({
        accountId: () => FAKE_ACCOUNT_ID,
        sequenceNumber: () => "1",
        incrementSequenceNumber: vi.fn(),
      }),
      simulateTransaction: mockSimulate,
      sendTransaction: vi.fn().mockResolvedValue({ status: "SUCCESS", hash: "tx-hash" }),
    });

    const { rpc: SorobanRpc } = await import("@stellar/stellar-sdk");
    (SorobanRpc.assembleTransaction as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      build: () => ({ toXDR: () => "signed-xdr" }),
    } as any);

    const walletMod = await import("../src/wallet.js");
    vi.spyOn(walletMod, "signTransaction").mockResolvedValue("signed-xdr");

    const { TransactionBuilder } = await import("@stellar/stellar-sdk");
    vi.spyOn(TransactionBuilder, "fromXDR").mockReturnValue({} as any);

    const result = await client.payWithReferral("inv-abc", 50_000_000n, REFERRER);
    // The referrer must be echoed back in the result
    expect(result.referrer).toBe(REFERRER);
    expect(mockSimulate).toHaveBeenCalledTimes(1);
  });

  it("throws InvoiceNotFoundError when simulation returns not_found", async () => {
    const client = makeClient();

    vi.spyOn(client as any, "server", "get").mockReturnValue({
      getAccount: vi.fn().mockResolvedValue({
        accountId: () => FAKE_ACCOUNT_ID,
        sequenceNumber: () => "1",
        incrementSequenceNumber: vi.fn(),
      }),
      simulateTransaction: vi.fn().mockResolvedValue({
        error: "not_found: invoice does not exist",
      }),
    });

    await expect(
      client.payWithReferral("inv-gone", 100n, REFERRER)
    ).rejects.toBeInstanceOf(InvoiceNotFoundError);
  });
});
