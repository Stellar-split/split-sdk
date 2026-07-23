import { describe, it, expect, beforeAll } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { StellarSplitClient } from "../../src/client.js";
import {
  TESTNET_HORIZON,
  TESTNET_PASSPHRASE,
  TESTNET_RPC,
  getTxDebug,
} from "./utils/stellarDebug.js";
import { fundAccount } from "./utils/friendbot.js";

const CONTRACT_ID = process.env.STELLAR_SPLIT_CONTRACT_ID ?? "";

// Hard gate: integration tests must never run on mainnet.
const isTestnet = process.env.STELLAR_NETWORK === "testnet";

// Provide a deterministic set of invoice params.
function deadlineInDays(days: number): number {
  return Math.floor(Date.now() / 1000) + days * 86_400;
}

// Use a single invoice id across the suite? Not required; each scenario creates
// its own invoice.

describe("StellarSplit integration (testnet)", () => {
  // If not in testnet, skip the entire suite to prevent accidental mainnet usage.
  if (!isTestnet) {
    // Vitest: throwing is undesirable; use explicit skip behavior.
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    it.skip("skipped: STELLAR_NETWORK must be=testnet", () => {});
    return;
  }

  if (!CONTRACT_ID) {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    it("fails fast: missing STELLAR_SPLIT_CONTRACT_ID", () => {
      throw new Error("Missing env STELLAR_SPLIT_CONTRACT_ID");
    });
    return;
  }

  let creator: Keypair;
  let payer: Keypair;
  let recipient1: Keypair;
  let client: StellarSplitClient;

  beforeAll(async () => {
    // Fresh keypairs funded via Friendbot for this suite run.
    creator = Keypair.random();
    payer = Keypair.random();
    recipient1 = Keypair.random();

    await Promise.all([
      fundAccount(creator.publicKey()),
      fundAccount(payer.publicKey()),
      fundAccount(recipient1.publicKey()),
    ]);

    client = new StellarSplitClient({
      rpcUrl: TESTNET_RPC,
      networkPassphrase: TESTNET_PASSPHRASE,
      contractId: CONTRACT_ID,
      horizonUrl: TESTNET_HORIZON,
      // Disable any client-side caching by default (safer across tx ordering).
      cache: { enabled: false },
    });
  }, 60_000);

  it("create invoice → verify state", async () => {
    const deadline = deadlineInDays(7);

    // Token contract address:
    // On real testnet we must pass the deployed token contract address.
    // For now, we use STELLAR_SPLIT_TOKEN_CONTRACT_ID if provided, otherwise
    // we fall back to CONTRACT_ID to match existing e2e behavior.
    const token = process.env.STELLAR_SPLIT_TOKEN_CONTRACT_ID ?? CONTRACT_ID;

    const { invoiceId, txHash } = await client.createInvoice({
      creator: creator.publicKey(),
      recipients: [{ address: recipient1.publicKey(), amount: 10_000_000n }],
      token,
      deadline,
    });

    const txDebug = await getTxDebug(TESTNET_RPC, txHash);
    // Ledger sequence + tx hash for debugging
    console.log("[createInvoice]", {
      invoiceId,
      txHash,
      ledger: txDebug?.ledger,
    });

    const invoice = await client.getInvoice(invoiceId);
    expect(invoice.id).toBe(invoiceId);
    expect(invoice.creator).toBe(creator.publicKey());
    expect(invoice.status).toBe("Pending");
    expect(invoice.funded).toBe(0n);
    expect(invoice.recipients.length).toBe(1);
    expect(invoice.recipients[0].address).toBe(recipient1.publicKey());
    expect(invoice.recipients[0].amount).toBe(10_000_000n);
  }, 60_000);

  it("pay invoice → verify funded", async () => {
    const deadline = deadlineInDays(7);
    const token = process.env.STELLAR_SPLIT_TOKEN_CONTRACT_ID ?? CONTRACT_ID;

    const { invoiceId } = await client.createInvoice({
      creator: creator.publicKey(),
      recipients: [{ address: recipient1.publicKey(), amount: 20_000_000n }],
      token,
      deadline,
    });

    // NOTE: StellarSplitClient.pay() signs via wallet adapter.
    // In this integration suite we expect the SDK to use a default signer
    // available in the test environment.
    // If your environment requires explicit adapter injection, add it here.
    const payAmount = 7_000_000n;
    const { txHash } = await client.pay({
      payer: payer.publicKey(),
      invoiceId,
      amount: payAmount,
    });

    const txDebug = await getTxDebug(TESTNET_RPC, txHash);
    console.log("[pay]", {
      invoiceId,
      txHash,
      ledger: txDebug?.ledger,
      payAmount: payAmount.toString(),
    });

    const invoice = await client.getInvoice(invoiceId);
    expect(invoice.id).toBe(invoiceId);
    expect(invoice.funded).toBe(payAmount);
    expect(invoice.status).toBe("Pending");
    expect(invoice.payments.length).toBeGreaterThan(0);
  }, 60_000);

  it("release funds → verify balances change", async () => {
    const deadline = deadlineInDays(7);
    const token = process.env.STELLAR_SPLIT_TOKEN_CONTRACT_ID ?? CONTRACT_ID;

    // Capture balances before
    const before = await client.getAccountBalances(recipient1.publicKey());

    const totalAmount = 12_000_000n;
    const { invoiceId } = await client.createInvoice({
      creator: creator.publicKey(),
      recipients: [{ address: recipient1.publicKey(), amount: totalAmount }],
      token,
      deadline,
    });

    // Pay full amount
    const { txHash: payTxHash } = await client.pay({
      payer: payer.publicKey(),
      invoiceId,
      amount: totalAmount,
    });
    const payTxDebug = await getTxDebug(TESTNET_RPC, payTxHash);
    console.log("[release:pay]", {
      invoiceId,
      payTxHash,
      ledger: payTxDebug?.ledger,
    });

    // Release
    // Release method name varies across SDK versions.
    // The contract exposes `release_invoice` and the client should provide a
    // corresponding method.
    // For now we attempt `releaseInvoice` and fall back to `release` if present.
    const anyClient = client as any;
    if (typeof anyClient.releaseInvoice !== "function") {
      throw new Error("Missing client.releaseInvoice(invoiceId, creator)");
    }

    const { txHash: releaseTxHash } = await anyClient.releaseInvoice(
      invoiceId,
      creator.publicKey(),
    );
    const releaseTxDebug = await getTxDebug(TESTNET_RPC, releaseTxHash);
    console.log("[release]", {
      invoiceId,
      releaseTxHash,
      ledger: releaseTxDebug?.ledger,
    });

    const after = await client.getAccountBalances(recipient1.publicKey());

    // We can’t assert which asset moved without knowing token type.
    // Instead, we assert that at least one balance entry changed.
    const beforeStr = JSON.stringify(before);
    const afterStr = JSON.stringify(after);
    expect(afterStr).not.toBe(beforeStr);

    // Also verify invoice status
    const invoice = await client.getInvoice(invoiceId);
    expect(invoice.status).toBe("Released");
  }, 60_000);
});
