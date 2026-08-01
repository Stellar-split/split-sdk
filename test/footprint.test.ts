import { describe, expect, it, vi } from "vitest";
import {
  Account,
  BASE_FEE,
  Keypair,
  Operation,
  SorobanDataBuilder,
  Transaction,
  TransactionBuilder,
  rpc as SorobanRpc,
  xdr,
} from "@stellar/stellar-sdk";
import { footprintDiff } from "../src/utils/footprintDiff.js";
import { optimizeFootprint } from "../src/soroban/footprint.js";
import { submitTransaction } from "../src/transaction/submit.js";

const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

const scAddressContract =
  (xdr.ScAddress as unknown as { scAddressTypeContract?: (raw: Buffer) => unknown })
    .scAddressTypeContract ??
  (xdr.ScAddress as unknown as { contract: (raw: Buffer) => unknown }).contract;

/** Build a distinct contract-data ledger key from a 32-byte contract id + symbol. */
function contractDataKey(seed: number, symbol: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: scAddressContract(Buffer.alloc(32, seed)) as never,
      key: xdr.ScVal.scvSymbol(symbol),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

/** Encode a ledger key canonically for assertions. */
function encode(key: xdr.LedgerKey): string {
  return key.toXDR("base64");
}

/** Build a Soroban transaction declaring the given read-only / read-write keys. */
function buildSorobanTx(
  readOnly: xdr.LedgerKey[],
  readWrite: xdr.LedgerKey[],
): Transaction {
  const source = Keypair.random();
  const account = new Account(source.publicKey(), "0");
  const sorobanData = new SorobanDataBuilder()
    .setReadOnly(readOnly)
    .setReadWrite(readWrite)
    .setResources(100, 100, 100)
    .setResourceFee(100)
    .build();
  return new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
    sorobanData,
  })
    .addOperation(Operation.extendFootprintTtl({ extendTo: 100 }))
    .setTimeout(30)
    .build();
}

/** SimulateTransactionSuccessResponse with the given minimal footprint. */
function simSuccess(
  readOnly: xdr.LedgerKey[],
  readWrite: xdr.LedgerKey[],
): SorobanRpc.Api.SimulateTransactionSuccessResponse {
  const transactionData = new SorobanDataBuilder()
    .setReadOnly(readOnly)
    .setReadWrite(readWrite)
    .setResources(100, 100, 100)
    .setResourceFee(100);
  return {
    id: "mock",
    latestLedger: 100,
    events: [],
    transactionData,
    minResourceFee: "100",
  } as unknown as SorobanRpc.Api.SimulateTransactionSuccessResponse;
}

/** Read the declared footprint off a transaction envelope. */
function footprintOf(tx: Transaction): {
  readOnly: string[];
  readWrite: string[];
} {
  const ext = tx.toEnvelope().v1().tx().ext() as unknown as {
    sorobanData?: () => xdr.SorobanTransactionData;
  };
  const data = ext.sorobanData?.();
  if (!data) return { readOnly: [], readWrite: [] };
  const footprint = data.resources().footprint();
  return {
    readOnly: footprint.readOnly().map(encode),
    readWrite: footprint.readWrite().map(encode),
  };
}

describe("footprintDiff", () => {
  const keyA = contractDataKey(1, "a");
  const keyB = contractDataKey(2, "b");
  const keyC = contractDataKey(3, "c");

  it("classifies added, removed, and unchanged keys", () => {
    const diff = footprintDiff([keyA, keyB], [keyB, keyC]);

    expect(diff.removed.map(encode)).toEqual([encode(keyA)]);
    expect(diff.added.map(encode)).toEqual([encode(keyC)]);
    expect(diff.unchanged.map(encode)).toEqual([encode(keyB)]);
  });

  it("treats structurally identical keys from different builders as equal", () => {
    const clone = contractDataKey(2, "b");
    const diff = footprintDiff([keyA, keyB], [keyB, clone]);
    expect(diff.unchanged).toHaveLength(1);
    expect(diff.removed).toHaveLength(1);
    expect(diff.added).toHaveLength(0);
  });

  it("handles empty sets", () => {
    const diff = footprintDiff([], []);
    expect(diff).toEqual({ added: [], removed: [], unchanged: [] });
  });
});

describe("optimizeFootprint", () => {
  const keyA = contractDataKey(1, "a");
  const keyB = contractDataKey(2, "b");
  const keyC = contractDataKey(3, "c");

  it("trims a bloated footprint to exactly the simulation result", () => {
    const tx = buildSorobanTx([keyA, keyB], [keyC]);
    const sim = simSuccess([keyA], [keyC]);

    const optimized = optimizeFootprint(tx, sim);
    const footprint = footprintOf(optimized);

    expect(footprint.readOnly).toEqual([encode(keyA)]);
    expect(footprint.readWrite).toEqual([encode(keyC)]);
  });

  it("passes an already-minimal footprint through unchanged", () => {
    const tx = buildSorobanTx([keyA], [keyC]);
    const sim = simSuccess([keyA], [keyC]);

    const optimized = optimizeFootprint(tx, sim);
    const footprint = footprintOf(optimized);

    expect(footprint.readOnly).toEqual([encode(keyA)]);
    expect(footprint.readWrite).toEqual([encode(keyC)]);
    // Envelope-level XDR should be byte-identical when nothing was pruned.
    expect(optimized.toXDR()).toBe(tx.toXDR());
  });

  it("logs each removed key at debug level", () => {
    const tx = buildSorobanTx([keyA, keyB], [keyC]);
    const sim = simSuccess([keyA], [keyC]);
    const debug = vi.fn();
    const logger = { debug };

    optimizeFootprint(tx, sim, { logger });

    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug.mock.calls[0]![0]).toContain(encode(keyB));
  });

  it("does not mutate the input transaction", () => {
    const tx = buildSorobanTx([keyA, keyB], [keyC]);
    const before = tx.toXDR();

    optimizeFootprint(tx, simSuccess([keyA], [keyC]));

    expect(tx.toXDR()).toBe(before);
  });
});

describe("submitTransaction", () => {
  const keyA = contractDataKey(1, "a");
  const keyB = contractDataKey(2, "b");

  it("optimizes the footprint by default before submitting", async () => {
    const tx = buildSorobanTx([keyA, keyB], []);
    const sim = simSuccess([keyA], []);
    const submitted = vi.fn(async (t: Transaction) => ({
      status: "PENDING",
      hash: "abc",
      latestLedger: 1,
      latestLedgerCloseTime: 1,
    }));

    await submitTransaction({ submitTransaction: submitted }, tx, sim);

    expect(submitted).toHaveBeenCalledTimes(1);
    const sent = submitted.mock.calls[0]![0] as Transaction;
    expect(footprintOf(sent).readOnly).toEqual([encode(keyA)]);
  });

  it("skips optimization when { optimizeFootprint: false }", async () => {
    const tx = buildSorobanTx([keyA, keyB], []);
    const sim = simSuccess([keyA], []);
    const submitted = vi.fn(async (t: Transaction) => ({
      status: "PENDING",
      hash: "abc",
      latestLedger: 1,
      latestLedgerCloseTime: 1,
    }));

    await submitTransaction(
      { submitTransaction: submitted },
      tx,
      sim,
      { optimizeFootprint: false },
    );

    const sent = submitted.mock.calls[0]![0] as Transaction;
    expect(footprintOf(sent).readOnly).toEqual([encode(keyA), encode(keyB)]);
  });
});
