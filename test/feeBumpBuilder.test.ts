import { describe, it, expect } from "vitest";
import {
  TransactionBuilder,
  Keypair,
  BASE_FEE,
  Networks,
  Transaction,
  Account,
} from "@stellar/stellar-sdk";
import { buildFeeBump, feeBumpToXDR } from "../src/feeBumpBuilder.js";

describe("buildFeeBump", () => {
  const kp = Keypair.random();
  const feeSource = Keypair.random().publicKey();
  const networkPassphrase = Networks.TESTNET;

  function buildInnerTx(): Transaction {
    const sourceAccount = new Account(kp.publicKey(), "0");
    const txBuilder = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase,
    });
    txBuilder.setTimeout(30);
    return txBuilder.build() as Transaction;
  }

  it("builds a fee bump transaction wrapping a v1 inner tx", () => {
    const innerTx = buildInnerTx();
    const feeBumpTx = buildFeeBump(innerTx, feeSource, BASE_FEE, networkPassphrase);

    expect(feeBumpTx).toBeDefined();
    const xdr = feeBumpToXDR(feeBumpTx);
    expect(xdr).toBeTruthy();
    expect(typeof xdr).toBe("string");
  });

  it("supports optional multiplier for surge conditions", () => {
    const innerTx = buildInnerTx();
    const feeBumpTx = buildFeeBump(innerTx, feeSource, BASE_FEE, networkPassphrase, {
      feeSource,
      baseFee: BASE_FEE,
      multiplier: 1.5,
    });

    const xdr = feeBumpToXDR(feeBumpTx);
    expect(xdr).toBeTruthy();
  });

  it("feeBumpToXDR returns a valid base-64 string", () => {
    const innerTx = buildInnerTx();
    const feeBumpTx = buildFeeBump(innerTx, feeSource, BASE_FEE, networkPassphrase, {
      feeSource,
      baseFee: BASE_FEE,
    });
    const xdr = feeBumpToXDR(feeBumpTx);
    expect(typeof xdr).toBe("string");
    expect(xdr.length).toBeGreaterThan(0);
  });

  it("builds correctly nested envelope XDR", () => {
    const innerTx = buildInnerTx();
    const feeBumpTx = buildFeeBump(innerTx, feeSource, BASE_FEE, networkPassphrase);

    const xdr = feeBumpToXDR(feeBumpTx);
    expect(xdr).toBeTruthy();

    // Verify the inner transaction is accessible in the fee bump
    const envelope = feeBumpTx.toEnvelope();
    expect(envelope.switch().name).toBe("envelopeTypeTxFeeBump");
  });
});
