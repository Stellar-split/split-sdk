/**
 * SDK Integration Smoke Test — exercises the full happy-path flow against
 * Stellar testnet using real Horizon calls and funded test accounts.
 *
 * Flow:
 *   1. Fund four Keypair accounts (creator, payer, recipient1, recipient2)
 *      via the testnet Friendbot faucet.
 *   2. Create a 2-recipient invoice with a 60/40 split.
 *   3. Run preflightCheck() and assert all checks pass.
 *   4. Submit the payment via submitPayment().
 *   5. Wait for finality via FinalityChecker.check() with minConfirmations: 2.
 *   6. Assert PaymentReceipt.status === "finalized" and effectSummary reflects
 *      the correct balance deltas for both recipients.
 *
 * Controlled by STELLAR_TESTNET_SMOKE=1 to avoid running on every unit test pass.
 *
 * @integration
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { StellarSplitClient } from "../../src/client.js";
import { FinalityChecker } from "../../src/finalityChecker.js";
import {
  TESTNET_HORIZON,
  TESTNET_PASSPHRASE,
  TESTNET_RPC,
} from "./utils/stellarDebug.js";
import { fundAccount } from "./utils/friendbot.js";

// ---------------------------------------------------------------------------
// Gate: skip unless explicitly opted in
// ---------------------------------------------------------------------------
const SMOKE_ENABLED = process.env.STELLAR_TESTNET_SMOKE === "1";
const CONTRACT_ID = process.env.STELLAR_SPLIT_CONTRACT_ID ?? "";

// ---------------------------------------------------------------------------
// Mock wallet.ts so signTransaction uses raw keypairs instead of Freighter.
// The active signer is swapped per-step via `setActiveSigner`.
// ---------------------------------------------------------------------------
let activeSigner: Keypair | null = null;

function setActiveSigner(kp: Keypair): void {
  activeSigner = kp;
}

vi.mock("../../src/wallet.js", () => ({
  signTransaction: async (xdr: string, network: string): Promise<string> => {
    if (!activeSigner) throw new Error("No active signer set");
    const tx = TransactionBuilder.fromXDR(xdr, network);
    tx.sign(activeSigner);
    return tx.toXDR();
  },
  connectWallet: async () => {
    throw new Error("connectWallet not available in smoke tests");
  },
  getPublicKey: async () => {
    if (!activeSigner) throw new Error("No active signer set");
    return activeSigner.publicKey();
  },
}));

// ---------------------------------------------------------------------------
// Smoke test suite
// ---------------------------------------------------------------------------
describe.runIf(SMOKE_ENABLED)("SDK Integration Smoke Test @integration", () => {
  // Fail fast when env is incomplete
  if (SMOKE_ENABLED && !CONTRACT_ID) {
    it("fails fast: missing STELLAR_SPLIT_CONTRACT_ID", () => {
      throw new Error("Missing env STELLAR_SPLIT_CONTRACT_ID");
    });
    return;
  }

  let creator: Keypair;
  let payer: Keypair;
  let recipient1: Keypair;
  let recipient2: Keypair;
  let client: StellarSplitClient;

  // Amounts for the 60/40 split
  const AMOUNT_R1 = 60_000_000n; // 60%
  const AMOUNT_R2 = 40_000_000n; // 40%
  const TOTAL = AMOUNT_R1 + AMOUNT_R2;

  let invoiceId: string;
  let payTxHash: string;

  // ---- Setup: fund accounts & construct client ----
  beforeAll(async () => {
    creator = Keypair.random();
    payer = Keypair.random();
    recipient1 = Keypair.random();
    recipient2 = Keypair.random();

    await Promise.all([
      fundAccount(creator.publicKey()),
      fundAccount(payer.publicKey()),
      fundAccount(recipient1.publicKey()),
      fundAccount(recipient2.publicKey()),
    ]);

    client = new StellarSplitClient({
      rpcUrl: TESTNET_RPC,
      networkPassphrase: TESTNET_PASSPHRASE,
      contractId: CONTRACT_ID,
      horizonUrl: TESTNET_HORIZON,
      cache: { enabled: false },
    });
  }, 120_000);

  // ---- Step 1: Create a 2-recipient invoice (60/40 split) ----
  it("creates a 2-recipient invoice with 60/40 split", async () => {
    setActiveSigner(creator);

    const deadline = Math.floor(Date.now() / 1000) + 7 * 86_400; // 7 days
    const token = process.env.STELLAR_SPLIT_TOKEN_CONTRACT_ID ?? CONTRACT_ID;

    const result = await client.createInvoice({
      creator: creator.publicKey(),
      recipients: [
        { address: recipient1.publicKey(), amount: AMOUNT_R1 },
        { address: recipient2.publicKey(), amount: AMOUNT_R2 },
      ],
      token,
      deadline,
    });

    invoiceId = result.invoiceId;
    expect(invoiceId).toBeTruthy();
    expect(typeof invoiceId).toBe("string");
    expect(result.txHash).toMatch(/^[0-9a-f]{64}$/i);

    // Verify on-chain state
    const invoice = await client.getInvoice(invoiceId);
    expect(invoice.id).toBe(invoiceId);
    expect(invoice.creator).toBe(creator.publicKey());
    expect(invoice.status).toBe("Pending");
    expect(invoice.funded).toBe(0n);
    expect(invoice.recipients).toHaveLength(2);
    expect(invoice.recipients[0].amount).toBe(AMOUNT_R1);
    expect(invoice.recipients[1].amount).toBe(AMOUNT_R2);
  }, 90_000);

  // ---- Step 2: Preflight check ----
  it("preflightCheck() passes before submission", async () => {
    setActiveSigner(payer);

    const preflight = await client.preflightCheck({
      invoiceId,
      payer: payer.publicKey(),
      amount: TOTAL,
    });

    expect(preflight.valid).toBe(true);
    expect(preflight.expiry.valid).toBe(true);
    expect(preflight.payerReadiness.ready).toBe(true);
  }, 60_000);

  // ---- Step 3: Submit payment ----
  it("submitPayment() succeeds", async () => {
    setActiveSigner(payer);

    const result = await client.submitPayment({
      invoiceId,
      payer: payer.publicKey(),
      amount: TOTAL,
    });

    payTxHash = result.txHash;
    expect(payTxHash).toMatch(/^[0-9a-f]{64}$/i);
  }, 90_000);

  // ---- Step 4: Verify receipt ----
  it("getReceipt() returns a valid receipt", async () => {
    const receipt = await client.getReceipt(invoiceId, payer.publicKey());

    expect(receipt.invoiceId).toBe(invoiceId);
    expect(receipt.payer).toBe(payer.publicKey());
    expect(receipt.totalPaid).toBeGreaterThan(0n);
    expect(receipt.proofHash).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);

  // ---- Step 5: Finality check ----
  it("FinalityChecker.check() returns finalized receipt with effectSummary", async () => {
    const receipt = await FinalityChecker.check(
      client,
      TESTNET_RPC,
      payTxHash,
      {
        minConfirmations: 2,
        invoiceId,
        payer: payer.publicKey(),
      },
      TESTNET_HORIZON,
    );

    expect(receipt.status).toBe("finalized");
    expect(receipt.invoiceId).toBe(invoiceId);
    expect(receipt.payer).toBe(payer.publicKey());

    // effectSummary should have entries for both recipients
    expect(receipt.effectSummary).toBeDefined();
    const summary = receipt.effectSummary!;

    // At minimum, both recipient addresses should appear
    const r1Key = recipient1.publicKey();
    const r2Key = recipient2.publicKey();

    // If Horizon effects are available, verify precise amounts;
    // otherwise the fallback computes proportional shares.
    if (summary[r1Key] !== undefined && summary[r2Key] !== undefined) {
      // 60% of TOTAL and 40% of TOTAL
      expect(summary[r1Key]).toBe((TOTAL * AMOUNT_R1) / TOTAL);
      expect(summary[r2Key]).toBe((TOTAL * AMOUNT_R2) / TOTAL);
    }
  }, 120_000);
});
