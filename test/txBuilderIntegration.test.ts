import { describe, it, expect } from "vitest";
import { Keypair, StrKey, Asset, Networks } from "@stellar/stellar-sdk";
import { StellarSplitTxBuilder } from "../src/txBuilder.js";
import { PaymentExpiredError } from "../src/errors.js";

const config = () => ({
  rpcUrl: "http://localhost:8000",
  networkPassphrase: Networks.TESTNET,
  contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
});

describe("StellarSplitTxBuilder integration (issue #1303)", () => {
  const source = Keypair.random().publicKey();
  const dest = Keypair.random().publicKey();

  it("chains mixed contract and classic operations in insertion order", () => {
    const tx = new StellarSplitTxBuilder(config(), source)
      .addPay("1", 100n)
      .addRelease("1")
      .addManageData("note", "hello")
      .addPathPaymentStrictSend(Asset.native(), "10", dest, Asset.native(), "9", [])
      .addPathPaymentStrictReceive(Asset.native(), "11", dest, Asset.native(), "10", [])
      .addRefund("2")
      .addRolloverInvoice("2", 9999999999, source)
      .build();
    expect(tx.operations.map((o) => o.type)).toEqual([
      "invokeHostFunction",
      "invokeHostFunction",
      "manageData",
      "pathPaymentStrictSend",
      "pathPaymentStrictReceive",
      "invokeHostFunction",
      "invokeHostFunction",
    ]);
    expect(tx.source).toBe(source);
    expect(tx.networkPassphrase).toBe(Networks.TESTNET);
  });

  it("builds with sequence 0 and a 30s default timeout when no expiry is given", () => {
    const tx = new StellarSplitTxBuilder(config(), source).addRelease("1").build();
    expect(tx.sequence).toBe("1");
    const max = Number(tx.timeBounds?.maxTime);
    expect(max - Math.floor(Date.now() / 1000)).toBeGreaterThan(20);
    expect(max - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(31);
  });

  it("derives timebounds from expiresAt and caps them at 12 hours", () => {
    const now = Math.floor(Date.now() / 1000);
    const near = new StellarSplitTxBuilder(config(), source).addRelease("1").build({ expiresAt: now + 120 });
    expect(Number(near.timeBounds?.maxTime) - now).toBeLessThanOrEqual(121);
    const far = new StellarSplitTxBuilder(config(), source).addRelease("1").build({ expiresAt: now + 10 * 86400 });
    expect(Number(far.timeBounds?.maxTime) - now).toBeLessThanOrEqual(43201);
  });

  it("rejects an already expired invoice with PaymentExpiredError", () => {
    const b = new StellarSplitTxBuilder(config(), source).addRelease("7");
    expect(() => b.build({ expiresAt: Math.floor(Date.now() / 1000) - 5, invoiceId: "7" })).toThrow(PaymentExpiredError);
  });

  it("validates inputs: non-numeric invoice ids and fractional amounts throw", () => {
    const b = new StellarSplitTxBuilder(config(), source);
    expect(() => b.addPay("abc", 1)).toThrow();
    expect(() => b.addPay("1", 1.5)).toThrow();
    expect(() => b.addRelease("not-a-number")).toThrow();
  });

  it("rejects malformed classic operation arguments", () => {
    const b = new StellarSplitTxBuilder(config(), source);
    expect(() => b.addPathPaymentStrictSend(Asset.native(), "10", "bad-dest", Asset.native(), "9", [])).toThrow();
  });

  it("build is repeatable and does not consume the operation list", () => {
    const b = new StellarSplitTxBuilder(config(), source).addPay("1", 5);
    expect(b.build().operations).toHaveLength(1);
    expect(b.build().operations).toHaveLength(1);
  });

  it("attached helpers (ledger estimator) are chainable and used for expiry derivation", () => {
    const b = new StellarSplitTxBuilder(config(), source);
    expect(b.expiresAtFromLedger(100)).toBeUndefined();
    const estimator = { estimateCloseTime: () => new Date(5_000_000) } as any;
    expect(b.setLedgerEstimator(estimator)).toBe(b);
    expect(b.expiresAtFromLedger(100)).toBe(5000);
  });

  it("surge detection is a chainable opt-in", () => {
    const b = new StellarSplitTxBuilder(config(), source);
    expect(b.enableSurgeDetection()).toBe(b);
  });
});
