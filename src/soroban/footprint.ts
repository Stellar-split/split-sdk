import {
  rpc as SorobanRpc,
  SorobanDataBuilder,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { footprintDiff } from "../utils/footprintDiff.js";

/** Minimal logger surface used by the optimizer for removed-key diagnostics. */
export interface FootprintLogger {
  debug(message: string): void;
}

const noopLogger: FootprintLogger = { debug: () => undefined };

export interface OptimizeFootprintOptions {
  /** Receives a `debug`-level line for every ledger key pruned from the footprint. */
  logger?: FootprintLogger;
}

/**
 * Replaces a Soroban transaction's declared ledger-key footprint with the
 * minimal read/write key set reported by `simulateTransaction`, pruning
 * stale or overly broad keys that inflate inclusion fees.
 *
 * Reconstruction is done through `SorobanDataBuilder` semantics: the minimal
 * `SorobanTransactionData` from the simulation response is applied to a clone
 * of the original transaction (via `TransactionBuilder.cloneFrom`, the same
 * mechanism `assembleTransaction` uses), so all other fields — operations,
 * source, memo, time bounds, fee — are preserved.
 *
 * Each ledger key present in the original footprint but absent from the
 * simulation result is logged at debug level and dropped.
 *
 * @param tx  The Soroban transaction whose footprint should be optimized.
 * @param sim The successful simulation response carrying the minimal footprint.
 * @returns   A new transaction with the trimmed footprint. The input is not
 *            mutated.
 */
export function optimizeFootprint(
  tx: Transaction,
  sim: SorobanRpc.Api.SimulateTransactionSuccessResponse,
  options: OptimizeFootprintOptions = {},
): Transaction {
  const logger = options.logger ?? noopLogger;

  const simData = toSorobanDataBuilder(sim.transactionData).build();
  const minimalReadOnly = simData.resources().footprint().readOnly();
  const minimalReadWrite = simData.resources().footprint().readWrite();

  const originalData = readSorobanData(tx);
  if (originalData) {
    const originalKeys = [
      ...originalData.resources().footprint().readOnly(),
      ...originalData.resources().footprint().readWrite(),
    ];
    const diff = footprintDiff(originalKeys, [
      ...minimalReadOnly,
      ...minimalReadWrite,
    ]);
    for (const key of diff.removed) {
      logger.debug(
        `[footprint] removing surplus ledger key ${key.toXDR("base64")}`,
      );
    }
  }

  return TransactionBuilder.cloneFrom(tx, {
    // Preserve the original classic fee explicitly — cloneFrom only copies it
    // when not overridden, and this guarantees byte-identical output for an
    // already-minimal footprint.
    fee: tx.fee,
    networkPassphrase: tx.networkPassphrase,
    sorobanData: simData,
  }).build();
}

/**
 * Normalizes `sim.transactionData` (a `SorobanDataBuilder` for parsed success
 * responses) into a builder. Raw string payloads are parsed defensively.
 */
function toSorobanDataBuilder(
  transactionData: SorobanDataBuilder | string,
): SorobanDataBuilder {
  if (typeof transactionData === "string") {
    return new SorobanDataBuilder(transactionData);
  }
  return transactionData;
}

/**
 * Reads the declared `SorobanTransactionData` off a transaction envelope, or
 * `undefined` for classic (non-Soroban) transactions.
 *
 * The soroban data lives on the transaction envelope's `TransactionV1.ext`
 * arm — the same location the protocol uses for `SorobanTransactionData`.
 */
function readSorobanData(tx: Transaction): xdr.SorobanTransactionData | undefined {
  const envelope = tx.toEnvelope();
  const v1 = envelope.v1();
  // Classic (pre-protocol-13 / V0) envelopes have no V1 arm; there is nothing
  // to optimize or diff against.
  if (!v1) return undefined;
  const txV1 = v1.tx();
  const ext = txV1.ext();
  if (typeof ext.sorobanData === "function") {
    const data = ext.sorobanData();
    if (data) return data;
  }
  return undefined;
}
