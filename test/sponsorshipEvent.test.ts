/**
 * Tests for submitSponsoredTransaction — SponsorshipUsed event feeSource attribution.
 *
 * Isolated in its own file so the vi.mock for @stellar/stellar-sdk does not
 * interfere with the existing sponsorship.test.ts mock setup.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Transaction } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SPONSOR    = "GBSPONSOR0000000000000000000000000000000000000000000000000";
const NEW_ACCOUNT = "GBNEWACCOUNT000000000000000000000000000000000000000000000";
const SUBMITTER  = "GSUBMITTER0000000000000000000000000000000000000000000000";
const RPC_URL    = "https://soroban-testnet.stellar.org";
const TX_HASH    = "abc123txhash0000000000000000000000000000000000000000000000";

// ---------------------------------------------------------------------------
// Minimal mock for @stellar/stellar-sdk rpc.Server
// ---------------------------------------------------------------------------

vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual<typeof import("@stellar/stellar-sdk")>(
    "@stellar/stellar-sdk"
  );
  return {
    ...(actual as Record<string, unknown>),
    rpc: {
      Server: vi.fn().mockImplementation(() => ({
        sendTransaction: vi.fn().mockResolvedValue({ hash: TX_HASH }),
      })),
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal fake transaction whose .source is the given address. */
function makeMockTx(source: string): Transaction {
  return { source } as unknown as Transaction;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("submitSponsoredTransaction — SponsorshipUsed event", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets feeSource to the sponsor account (tx.source), not the submitter", async () => {
    const { submitSponsoredTransaction } = await import("../src/sponsorship.js");

    const tx = makeMockTx(SPONSOR);
    const event = await submitSponsoredTransaction(tx, NEW_ACCOUNT, RPC_URL);

    // feeSource must be the sponsor (tx.source), not some other address
    expect(event.feeSource).toBe(SPONSOR);
  });

  it("emits the correct newAccount in the SponsorshipUsed event", async () => {
    const { submitSponsoredTransaction } = await import("../src/sponsorship.js");

    const tx = makeMockTx(SPONSOR);
    const event = await submitSponsoredTransaction(tx, NEW_ACCOUNT, RPC_URL);

    expect(event.newAccount).toBe(NEW_ACCOUNT);
  });

  it("includes the txHash returned by the RPC node in the event", async () => {
    const { submitSponsoredTransaction } = await import("../src/sponsorship.js");

    const tx = makeMockTx(SPONSOR);
    const event = await submitSponsoredTransaction(tx, NEW_ACCOUNT, RPC_URL);

    expect(event.txHash).toBe(TX_HASH);
  });

  it("invokes the optional onEvent callback with the SponsorshipUsed payload", async () => {
    const { submitSponsoredTransaction } = await import("../src/sponsorship.js");

    const tx = makeMockTx(SPONSOR);
    const onEvent = vi.fn();
    await submitSponsoredTransaction(tx, NEW_ACCOUNT, RPC_URL, onEvent);

    expect(onEvent).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        feeSource:  SPONSOR,
        newAccount: NEW_ACCOUNT,
        txHash:     TX_HASH,
      })
    );
  });

  it("non-sponsored: feeSource equals the submitter (tx.source) when tx is not sponsor-wrapped", async () => {
    const { submitSponsoredTransaction } = await import("../src/sponsorship.js");

    // When there is no sponsor wrapper, tx.source is the submitter's address.
    // submitSponsoredTransaction must NOT hard-code the sponsor — it reads
    // tx.source directly, so the correct account is always attributed.
    const tx = makeMockTx(SUBMITTER);
    const event = await submitSponsoredTransaction(tx, NEW_ACCOUNT, RPC_URL);

    expect(event.feeSource).toBe(SUBMITTER);
    expect(event.feeSource).not.toBe(SPONSOR);
  });
});
