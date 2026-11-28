/**
 * Tests for issue #878 — Fundraising Round: closeRound and getRoundInfo
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair, StrKey, nativeToScVal } from "@stellar/stellar-sdk";
import { StellarSplitClient } from "../src/client.js";

// `rpc.assembleTransaction` is a non-configurable getter on the real SDK
// namespace, so it can't be `vi.spyOn`-ed directly; override it via a
// partial module mock instead.
vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      assembleTransaction: vi.fn(),
    },
  };
});
import {
  RoundNotEndedError,
  InvoiceNotFoundError,
  SimulationFailedError,
} from "../src/errors.js";
import type { RoundCloseResult, RoundInfo } from "../src/types.js";

const FAKE_ACCOUNT_ID = Keypair.random().publicKey();

function makeClient() {
  return new StellarSplitClient({
    rpcUrl: "https://example.com",
    networkPassphrase: "Test Network",
    contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
  });
}

function makeSimSuccess(retval: unknown) {
  return {
    result: { retval: nativeToScVal(retval as bigint) },
    transactionData: { build: () => ({ toXDR: () => "" }) },
    minResourceFee: "100",
  };
}

describe("closeRound (#878)", () => {
  it("returns a RoundCloseResult on success", async () => {
    const client = makeClient();

    vi.spyOn(client as any, "server", "get").mockReturnValue({
      getAccount: vi.fn().mockResolvedValue({
        accountId: () => FAKE_ACCOUNT_ID,
        sequenceNumber: () => "1",
        incrementSequenceNumber: vi.fn(),
      }),
      simulateTransaction: vi.fn().mockResolvedValue({
        result: {
          retval: nativeToScVal({
            total_raised: 100_000_000n,
            hard_cap: 200_000_000n,
            overflow: 0n,
            refunds: [],
          } as unknown as bigint),
        },
        transactionData: { build: () => ({ toXDR: () => "" }) },
        minResourceFee: "100",
      }),
      sendTransaction: vi
        .fn()
        .mockResolvedValue({ status: "SUCCESS", hash: "close-round-tx" }),
    });

    // Mock assembleTransaction + signTransaction
    const { rpc: SorobanRpc } = await import("@stellar/stellar-sdk");
    (SorobanRpc.assembleTransaction as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      build: () => ({ toXDR: () => "signed-xdr" }),
    } as any);

    const walletMod = await import("../src/wallet.js");
    vi.spyOn(walletMod, "signTransaction").mockResolvedValue("signed-xdr");

    const { TransactionBuilder } = await import("@stellar/stellar-sdk");
    vi.spyOn(TransactionBuilder, "fromXDR").mockReturnValue({} as any);

    const result: RoundCloseResult = await client.closeRound("inv-123");
    expect(result).toHaveProperty("txHash");
    expect(result).toHaveProperty("refunds");
    expect(Array.isArray(result.refunds)).toBe(true);
  });

  it("throws RoundNotEndedError when simulation returns round_not_ended", async () => {
    const client = makeClient();

    vi.spyOn(client as any, "server", "get").mockReturnValue({
      getAccount: vi.fn().mockResolvedValue({
        accountId: () => FAKE_ACCOUNT_ID,
        sequenceNumber: () => "1",
        incrementSequenceNumber: vi.fn(),
      }),
      simulateTransaction: vi.fn().mockResolvedValue({
        error: "round_not_ended: round ends at 9999999999",
      }),
    });

    await expect(client.closeRound("inv-456")).rejects.toBeInstanceOf(RoundNotEndedError);
  });

  it("throws RoundNotEndedError when simulation returns RoundNotEnded", async () => {
    const client = makeClient();

    vi.spyOn(client as any, "server", "get").mockReturnValue({
      getAccount: vi.fn().mockResolvedValue({
        accountId: () => FAKE_ACCOUNT_ID,
        sequenceNumber: () => "1",
        incrementSequenceNumber: vi.fn(),
      }),
      simulateTransaction: vi.fn().mockResolvedValue({
        error: "RoundNotEnded",
      }),
    });

    await expect(client.closeRound("inv-789")).rejects.toBeInstanceOf(RoundNotEndedError);
  });

  it("throws SimulationFailedError for unrecognised simulation errors", async () => {
    const client = makeClient();

    vi.spyOn(client as any, "server", "get").mockReturnValue({
      getAccount: vi.fn().mockResolvedValue({
        accountId: () => FAKE_ACCOUNT_ID,
        sequenceNumber: () => "1",
        incrementSequenceNumber: vi.fn(),
      }),
      simulateTransaction: vi.fn().mockResolvedValue({
        error: "some_other_error",
      }),
    });

    await expect(client.closeRound("inv-000")).rejects.toBeInstanceOf(SimulationFailedError);
  });
});

describe("getRoundInfo (#878)", () => {
  it("returns a RoundInfo object on success", async () => {
    const client = makeClient();

    vi.spyOn(client as any, "server", "get").mockReturnValue({
      getAccount: vi.fn().mockResolvedValue({
        accountId: () => FAKE_ACCOUNT_ID,
        sequenceNumber: () => "1",
        incrementSequenceNumber: vi.fn(),
      }),
      simulateTransaction: vi.fn().mockResolvedValue({
        result: {
          retval: nativeToScVal({
            total_raised: 50_000_000n,
            hard_cap: 100_000_000n,
            round_end: 9999999999,
            closed: false,
          } as unknown as bigint),
        },
        transactionData: { build: () => ({ toXDR: () => "" }) },
        minResourceFee: "100",
      }),
    });

    const result: RoundInfo = await client.getRoundInfo("inv-abc");
    expect(result.invoiceId).toBe("inv-abc");
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
        error: "not_found: invoice inv-missing does not exist",
      }),
    });

    await expect(client.getRoundInfo("inv-missing")).rejects.toBeInstanceOf(InvoiceNotFoundError);
  });
});
