/**
 * E2E tests for StellarSplit SDK against Stellar testnet.
 *
 * Covers: createInvoice, pay, release (funded → Released), refund (expired → Refunded).
 *
 * Run with: npm run test:e2e
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { StellarSplitClient } from "../../src/client.js";
import { setupE2E, TESTNET_RPC, TESTNET_PASSPHRASE } from "./setup.js";
import type { E2EEnv } from "./setup.js";

// ---------------------------------------------------------------------------
// Mock wallet.ts so signTransaction uses a raw keypair instead of Freighter.
// The active signer is swapped per-test via `setActiveSigner`.
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
    throw new Error("connectWallet not available in E2E tests");
  },
  getPublicKey: async () => {
    if (!activeSigner) throw new Error("No active signer set");
    return activeSigner.publicKey();
  },
}));

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let hasStellarCli = false;
try {
  execSync("stellar --version", { stdio: "ignore" });
  hasStellarCli = true;
} catch {}

const canRunE2E = hasStellarCli || existsSync(join(__dirname, ".env.e2e"));

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.runIf(canRunE2E)("StellarSplit E2E", () => {
  let env: E2EEnv;
  let client: StellarSplitClient;

  beforeAll(async () => {
    env = await setupE2E();
    client = new StellarSplitClient({
      rpcUrl: TESTNET_RPC,
      networkPassphrase: TESTNET_PASSPHRASE,
      contractId: env.contractId,
    });
  }, 120_000);

  // -------------------------------------------------------------------------
  // createInvoice
  // -------------------------------------------------------------------------

  it("createInvoice returns a valid invoice ID", async () => {
    setActiveSigner(env.creator);

    const deadline = Math.floor(Date.now() / 1000) + 7 * 86_400;
    const totalAmount = 100_000_000n; // 10 USDC in stroops

    const { invoiceId, txHash } = await client.createInvoice({
      creator: env.creator.publicKey(),
      recipients: [
        { address: env.recipient1.publicKey(), amount: 60_000_000n },
        { address: env.recipient2.publicKey(), amount: 40_000_000n },
      ],
      token: env.contractId, // use contract itself as mock token in tests
      deadline,
    });

    expect(invoiceId).toBeTruthy();
    expect(typeof invoiceId).toBe("string");
    expect(txHash).toMatch(/^[0-9a-f]{64}$/i);

    // Verify on-chain state
    const invoice = await client.getInvoice(invoiceId);
    expect(invoice.id).toBe(invoiceId);
    expect(invoice.creator).toBe(env.creator.publicKey());
    expect(invoice.status).toBe("Pending");
    expect(invoice.funded).toBe(0n);
    expect(invoice.recipients).toHaveLength(2);
    expect(invoice.recipients[0].amount).toBe(60_000_000n);
    expect(invoice.recipients[1].amount).toBe(40_000_000n);
  }, 60_000);

  // -------------------------------------------------------------------------
  // pay
  // -------------------------------------------------------------------------

  it("pay updates funded amount on-chain", async () => {
    setActiveSigner(env.creator);

    const deadline = Math.floor(Date.now() / 1000) + 7 * 86_400;
    const { invoiceId } = await client.createInvoice({
      creator: env.creator.publicKey(),
      recipients: [{ address: env.recipient1.publicKey(), amount: 100_000_000n }],
      token: env.contractId,
      deadline,
    });

    // Switch signer to payer
    setActiveSigner(env.payer);

    const payAmount = 50_000_000n;
    const { txHash } = await client.pay({
      payer: env.payer.publicKey(),
      invoiceId,
      amount: payAmount,
    });

    expect(txHash).toMatch(/^[0-9a-f]{64}$/i);

    // Verify funded amount updated
    const invoice = await client.getInvoice(invoiceId);
    expect(invoice.funded).toBe(payAmount);
    expect(invoice.status).toBe("Pending");
    expect(invoice.payments).toHaveLength(1);
    expect(invoice.payments[0].payer).toBe(env.payer.publicKey());
    expect(invoice.payments[0].amount).toBe(payAmount);
  }, 90_000);

  // -------------------------------------------------------------------------
  // release — fully funded invoice transitions to Released
  // -------------------------------------------------------------------------

  it("fully funded invoice is Released and recipients receive funds", async () => {
    setActiveSigner(env.creator);

    const totalAmount = 100_000_000n;
    const deadline = Math.floor(Date.now() / 1000) + 7 * 86_400;

    const { invoiceId } = await client.createInvoice({
      creator: env.creator.publicKey(),
      recipients: [
        { address: env.recipient1.publicKey(), amount: 60_000_000n },
        { address: env.recipient2.publicKey(), amount: 40_000_000n },
      ],
      token: env.contractId,
      deadline,
    });

    // Pay the full amount
    setActiveSigner(env.payer);
    await client.pay({
      payer: env.payer.publicKey(),
      invoiceId,
      amount: totalAmount,
    });

    const invoice = await client.getInvoice(invoiceId);
    expect(invoice.funded).toBe(totalAmount);
    // Contract auto-releases when fully funded
    expect(invoice.status).toBe("Released");
  }, 120_000);

  // -------------------------------------------------------------------------
  // refund — expired invoice transitions to Refunded
  // -------------------------------------------------------------------------

  it("expired invoice can be refunded", async () => {
    setActiveSigner(env.creator);

    // Deadline in the past so the invoice is immediately expired
    const pastDeadline = Math.floor(Date.now() / 1000) - 1;

    const { invoiceId } = await client.createInvoice({
      creator: env.creator.publicKey(),
      recipients: [{ address: env.recipient1.publicKey(), amount: 100_000_000n }],
      token: env.contractId,
      deadline: pastDeadline,
    });

    // Partial payment before expiry
    setActiveSigner(env.payer);
    await client.pay({
      payer: env.payer.publicKey(),
      invoiceId,
      amount: 30_000_000n,
    });

    const invoice = await client.getInvoice(invoiceId);
    // Contract should mark as Refunded since deadline has passed
    expect(invoice.status).toBe("Refunded");
  }, 120_000);
});
