/**
 * Transaction Result XDR Decoder — parses the base64-encoded XDR
 * `TransactionResult` blob returned by Horizon/Soroban RPC after a
 * submission into a typed, JSON-safe object: fee charged, result code,
 * per-operation results, and (for fee-bump transactions) both the outer
 * fee-bump result and the nested inner transaction result.
 */

import { xdr } from "@stellar/stellar-sdk";
import type {
  DecodedOperationResult,
  DecodedTransactionResult,
} from "./types.js";

const FEE_BUMP_CODES = new Set([
  "txFeeBumpInnerSuccess",
  "txFeeBumpInnerFailed",
]);

/** Decode a single per-operation `xdr.OperationResult` entry. */
function decodeOperationResult(
  opResult: xdr.OperationResult,
): DecodedOperationResult {
  const code = opResult.switch().name;
  const decoded: DecodedOperationResult = { code };

  if (code === "opInner") {
    try {
      const tr = opResult.tr();
      decoded.operationType = tr.switch().name;
      try {
        decoded.resultCode = tr.value().switch().name;
      } catch {
        // Some operation results (e.g. inflation) don't nest a result union.
      }
    } catch {
      // best-effort
    }
  }

  return decoded;
}

/** Safely read the per-operation results array off a (inner) transaction result union. */
function safeOperationResults(
  resultUnion: xdr.TransactionResultResult | xdr.InnerTransactionResultResult,
): xdr.OperationResult[] {
  try {
    return resultUnion.results() ?? [];
  } catch {
    return [];
  }
}

/**
 * Decode a base64-encoded `TransactionResult` XDR string.
 *
 * @param resultXdr - Base64-encoded XDR of the Horizon/Soroban `TransactionResult`.
 * @returns A typed, JSON-safe `DecodedTransactionResult`.
 *
 * @example
 * ```ts
 * import { decodeTransactionResult } from "@stellar-split/sdk";
 *
 * const decoded = decodeTransactionResult(resultXdrBase64);
 * console.log(decoded.result.code, decoded.operationResults?.length);
 * ```
 */
export function decodeTransactionResult(
  resultXdr: string,
): DecodedTransactionResult {
  const buffer = Buffer.from(resultXdr, "base64");
  const result = xdr.TransactionResult.fromXDR(buffer);
  const resultUnion = result.result();
  const code = resultUnion.switch().name;
  const feeCharged = result.feeCharged().toString();

  const decoded: DecodedTransactionResult = {
    type: "TransactionResult",
    feeCharged,
    result: { code },
    operationResults: [],
  };

  if (FEE_BUMP_CODES.has(code)) {
    const pair = resultUnion.innerResultPair();
    const innerResult = pair.result();
    const innerResultUnion = innerResult.result();
    const innerCode = innerResultUnion.switch().name;
    const innerFeeCharged = innerResult.feeCharged().toString();
    const innerOperationResults = safeOperationResults(innerResultUnion).map(
      decodeOperationResult,
    );

    const inner: DecodedTransactionResult = {
      type: "TransactionResult",
      feeCharged: innerFeeCharged,
      result: { code: innerCode },
      operationResults: innerOperationResults,
    };

    decoded.feeBump = {
      outer: { feeCharged, code },
      inner,
    };
    decoded.operationResults = innerOperationResults;
  } else {
    decoded.operationResults = safeOperationResults(resultUnion).map(
      decodeOperationResult,
    );
  }

  return decoded;
}
