/**
 * Tests for issue #879 — Milestone management: completeMilestone, getActiveMilestone, getMilestones
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

/** Valid Stellar G-address used as the fake source account in tests. */
const FAKE_ACCOUNT_ID = Keypair.random().publicKey();
import {
  WrongMilestoneError,
  InvoiceNotFoundError,
  SimulationFailedError,
} from "../src/errors.js";
import type { MilestoneResult, Milestone } from "../src/types.js";

function makeClient() {
  return new StellarSplitClient({
    rpcUrl: "https://example.com",
    networkPassphrase: "Test Network",
    contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
  });
}

describe("completeMilestone (#879)", () => {
  it("returns MilestoneResult on success", async () => {
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
            amount_released: 500_000_000n,
            next_milestone_index: 1,
          } as unknown as bigint),
        },
        transactionData: { build: () => ({ toXDR: () => "" }) },
        minResourceFee: "100",
      }),
      sendTransaction: vi
        .fn()
        .mockResolvedValue({ status: "SUCCESS", hash: "milestone-tx" }),
    });

    const { rpc: SorobanRpc } = await import("@stellar/stellar-sdk");
    (SorobanRpc.assembleTransaction as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      build: () => ({ toXDR: () => "signed-xdr" }),
    } as any);

    const walletMod = await import("../src/wallet.js");
    vi.spyOn(walletMod, "signTransaction").mockResolvedValue("signed-xdr");

    const { TransactionBuilder } = await import("@stellar/stellar-sdk");
    vi.spyOn(TransactionBuilder, "fromXDR").mockReturnValue({} as any);

    const result: MilestoneResult = await client.completeMilestone("inv-123", 0);
    expect(result.index).toBe(0);
    expect(result).toHaveProperty("txHash");
    expect(result).toHaveProperty("amountReleased");
  });

  it("throws WrongMilestoneError when simulation returns wrong_milestone", async () => {
    const client = makeClient();

    vi.spyOn(client as any, "server", "get").mockReturnValue({
      getAccount: vi.fn().mockResolvedValue({
        accountId: () => FAKE_ACCOUNT_ID,
        sequenceNumber: () => "1",
        incrementSequenceNumber: vi.fn(),
      }),
      simulateTransaction: vi.fn().mockResolvedValue({
        error: "wrong_milestone: expected 1 but got 0",
      }),
    });

    await expect(client.completeMilestone("inv-123", 0)).rejects.toBeInstanceOf(WrongMilestoneError);
  });

  it("throws WrongMilestoneError when simulation returns WrongMilestone", async () => {
    const client = makeClient();

    vi.spyOn(client as any, "server", "get").mockReturnValue({
      getAccount: vi.fn().mockResolvedValue({
        accountId: () => FAKE_ACCOUNT_ID,
        sequenceNumber: () => "1",
        incrementSequenceNumber: vi.fn(),
      }),
      simulateTransaction: vi.fn().mockResolvedValue({
        error: "WrongMilestone",
      }),
    });

    await expect(client.completeMilestone("inv-123", 2)).rejects.toBeInstanceOf(WrongMilestoneError);
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

    await expect(client.completeMilestone("inv-missing", 0)).rejects.toBeInstanceOf(
      InvoiceNotFoundError
    );
  });

  it("throws SimulationFailedError for unknown simulation errors", async () => {
    const client = makeClient();

    vi.spyOn(client as any, "server", "get").mockReturnValue({
      getAccount: vi.fn().mockResolvedValue({
        accountId: () => FAKE_ACCOUNT_ID,
        sequenceNumber: () => "1",
        incrementSequenceNumber: vi.fn(),
      }),
      simulateTransaction: vi.fn().mockResolvedValue({
        error: "unexpected_contract_error",
      }),
    });

    await expect(client.completeMilestone("inv-123", 0)).rejects.toBeInstanceOf(
      SimulationFailedError
    );
  });

  it("WrongMilestoneError carries requestedIndex and invoiceId", async () => {
    const client = makeClient();

    vi.spyOn(client as any, "server", "get").mockReturnValue({
      getAccount: vi.fn().mockResolvedValue({
        accountId: () => FAKE_ACCOUNT_ID,
        sequenceNumber: () => "1",
        incrementSequenceNumber: vi.fn(),
      }),
      simulateTransaction: vi.fn().mockResolvedValue({
        error: "WrongMilestone",
      }),
    });

    try {
      await client.completeMilestone("inv-err", 3);
    } catch (err) {
      expect(err).toBeInstanceOf(WrongMilestoneError);
      const typed = err as WrongMilestoneError;
      expect(typed.invoiceId).toBe("inv-err");
      expect(typed.requestedIndex).toBe(3);
    }
  });
});

describe("getActiveMilestone (#879)", () => {
  it("returns null when contract returns no value", async () => {
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

    const result = await client.getActiveMilestone("inv-abc");
    expect(result).toBeNull();
  });

  it("throws InvoiceNotFoundError when not_found in simulation error", async () => {
    const client = makeClient();

    vi.spyOn(client as any, "server", "get").mockReturnValue({
      getAccount: vi.fn().mockResolvedValue({
        accountId: () => FAKE_ACCOUNT_ID,
        sequenceNumber: () => "1",
        incrementSequenceNumber: vi.fn(),
      }),
      simulateTransaction: vi.fn().mockResolvedValue({
        error: "not_found: no such invoice",
      }),
    });

    await expect(client.getActiveMilestone("inv-gone")).rejects.toBeInstanceOf(
      InvoiceNotFoundError
    );
  });
});

describe("getMilestones (#879)", () => {
  it("returns an empty array when no milestones present", async () => {
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

    const result: Milestone[] = await client.getMilestones("inv-abc");
    expect(Array.isArray(result)).toBe(true);
  });

  it("throws InvoiceNotFoundError for not_found simulation error", async () => {
    const client = makeClient();

    vi.spyOn(client as any, "server", "get").mockReturnValue({
      getAccount: vi.fn().mockResolvedValue({
        accountId: () => FAKE_ACCOUNT_ID,
        sequenceNumber: () => "1",
        incrementSequenceNumber: vi.fn(),
      }),
      simulateTransaction: vi.fn().mockResolvedValue({
        error: "not_found: invoice gone",
      }),
    });

    await expect(client.getMilestones("inv-gone")).rejects.toBeInstanceOf(InvoiceNotFoundError);
  });
});
