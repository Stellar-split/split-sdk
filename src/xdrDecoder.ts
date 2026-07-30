/**
 * XDR Decoder — translates opaque Stellar XDR binary (base64) into
 * structured JSON objects safe for logging, audit trails, and developer UIs.
 *
 * Uses the @stellar/stellar-sdk `xdr` namespace to decode all major XDR types.
 */

import { xdr, StrKey } from "@stellar/stellar-sdk";
import type {
  XDRType,
  DecodedXDR,
  DecodedTransactionEnvelope,
  DecodedTransactionResult,
  DecodedTransactionMeta,
  DecodedLedgerEntry,
  DecodedOperation,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a Stellar address (raw AccountId Ed25519 bytes) to a G... string. */
function accountIdToString(accountId: xdr.AccountId): string {
  try {
    const ed25519 = accountId.ed25519();
    if (ed25519) {
      return StrKey.encodeEd25519PublicKey(ed25519);
    }
    // Fallback: use XDR base64 representation
    return accountId.toXDR("base64");
  } catch {
    return "unknown";
  }
}

/** Safely stringify a bigint or number for JSON compatibility. */
function bigintToString(value: bigint | number | string): string {
  return typeof value === "bigint" ? value.toString() : String(value);
}

/** Decode a single Stellar operation into a structured object. */
function decodeOperation(
  body: xdr.OperationBody,
  sourceAccount: xdr.MuxedAccount | null,
): DecodedOperation {
  const bodyRaw: Record<string, unknown> = {};
  try {
    const serialized = body.toXDR("base64");
    bodyRaw._xdr = serialized;
  } catch {
    // best-effort
  }

  return {
    type: body.switch().name,
    sourceAccount: sourceAccount
      ? accountIdToString(sourceAccount as unknown as xdr.AccountId)
      : undefined,
    body: bodyRaw,
  };
}

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

/**
 * Decode a base64-encoded TransactionEnvelope XDR.
 */
function decodeTransactionEnvelope(
  envelope: xdr.TransactionEnvelope,
): DecodedTransactionEnvelope {
  let tx: DecodedTransactionEnvelope["tx"] | null = null;

  try {
    if (envelope.switch() === xdr.EnvelopeType.envelopeTypeTxV0()) {
      const v0 = envelope.v0();
      tx = {
        sourceAccount: accountIdToString(v0.tx().sourceAccountEd25519() as unknown as xdr.AccountId),
        fee: v0.tx().fee().toString(),
        seqNum: v0.tx().seqNum().toString(),
        memo: undefined,
        operations: (v0.tx().operations() ?? []).map((op) =>
          decodeOperation(op.body(), op.sourceAccount()),
        ),
        timeBounds: (() => {
          try {
            const tb = v0.tx().timeBounds();
            if (tb) {
              return {
                minTime: tb.minTime().toString(),
                maxTime: tb.maxTime().toString(),
              };
            }
          } catch { /* no timebounds */ }
          return undefined;
        })(),
      };
    } else if (envelope.switch() === xdr.EnvelopeType.envelopeTypeTx()) {
      const v1 = envelope.v1();
      tx = {
        sourceAccount: accountIdToString(v1.tx().sourceAccount() as unknown as xdr.AccountId),
        fee: v1.tx().fee().toString(),
        seqNum: v1.tx().seqNum().toString(),
        memo: (() => {
          try {
            return v1.tx().memo().switch().name;
          } catch {
            return undefined;
          }
        })(),
        operations: (v1.tx().operations() ?? []).map((op) =>
          decodeOperation(op.body(), op.sourceAccount()),
        ),
        timeBounds: (() => {
          try {
            const tb = v1.tx().timeBounds();
            if (tb) {
              return {
                minTime: tb.minTime().toString(),
                maxTime: tb.maxTime().toString(),
              };
            }
          } catch { /* no timebounds */ }
          return undefined;
        })(),
      };
    } else if (envelope.switch() === xdr.EnvelopeType.envelopeTypeTxFeeBump()) {
      const fb = envelope.feeBump();
      const inner = fb.tx().innerTx().v1();
      tx = {
        sourceAccount: accountIdToString(fb.tx().feeSource() as unknown as xdr.AccountId),
        fee: fb.tx().fee().toString(),
        seqNum: "0",
        operations: (inner?.tx().operations() ?? []).map((op) =>
          decodeOperation(op.body(), op.sourceAccount()),
        ),
        timeBounds: undefined,
      };
    }
  } catch {
    // graceful fallback
  }

  return {
    type: "TransactionEnvelope",
    tx: tx ?? {
      sourceAccount: "unknown",
      fee: "0",
      seqNum: "0",
      operations: [],
    },
  };
}

/**
 * Decode a base64-encoded TransactionResult XDR.
 */
function decodeTransactionResult(
  result: xdr.TransactionResult,
): DecodedTransactionResult {
  let resultCode = "unknown";
  let innerResult: Record<string, unknown> | undefined;

  try {
    resultCode = result.result().switch().name;
    const inner = result.result().innerResult();
    if (inner) {
      innerResult = {
        switch: inner.value().switch().name,
      };
    }
  } catch {
    // best-effort
  }

  return {
    type: "TransactionResult",
    feeCharged: result.feeCharged().toString(),
    result: {
      code: resultCode,
      innerResult,
    },
  };
}

/**
 * Decode a base64-encoded TransactionMeta XDR.
 */
function decodeTransactionMeta(
  meta: xdr.TransactionMeta,
): DecodedTransactionMeta {
  const operations: DecodedTransactionMeta["operations"] = [];

  try {
    const opsMeta = meta.v3()?.operations() ?? [];
    for (const opMeta of opsMeta) {
      const changes = (opMeta.changes() ?? []).map((change) => ({
        type: change.switch().name,
        key: change.key()?.toXDR("base64") ?? "unknown",
      }));
      operations.push({ changes });
    }
  } catch {
    // graceful: return empty operations list
  }

  return { type: "TransactionMeta", operations };
}

/**
 * Decode a base64-encoded LedgerEntry XDR.
 */
function decodeLedgerEntry(
  entry: xdr.LedgerEntry,
): DecodedLedgerEntry {
  const data: DecodedLedgerEntry["data"] = { type: entry.data().switch().name };

  try {
    const account = entry.data().account();
    if (account) {
      data.accountId = account.accountId().toXDR("base64");
      data.balance = account.balance().toString();
      data.flags = account.flags();
      data.signers = (account.signers() ?? []).map((s) => ({
        key: s.key().toXDR("base64"),
        weight: s.weight(),
      }));
      data.thresholds = {
        low: account.thresholds()[0],
        med: account.thresholds()[1],
        high: account.thresholds()[2],
      };
    }
  } catch {
    // best-effort
  }

  return {
    type: "LedgerEntry",
    lastModifiedLedgerSeq: entry.lastModifiedLedgerSeq(),
    data,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decode a base64-encoded XDR string into a structured JSON-safe object.
 *
 * @param xdrBase64 - Base64-encoded XDR string.
 * @param type      - The expected XDR type.
 * @returns A typed DecodedXDR union object.
 *
 * @example
 * ```ts
 * import { decodeXDR } from "@stellar-split/sdk";
 *
 * const decoded = decodeXDR(rawTxEnvelope, "TransactionEnvelope");
 * console.log(decoded.tx.sourceAccount, decoded.tx.operations.length);
 * ```
 */
export function decodeXDR(xdrBase64: string, type: XDRType): DecodedXDR {
  const buffer = Buffer.from(xdrBase64, "base64");

  switch (type) {
    case "TransactionEnvelope": {
      const envelope = xdr.TransactionEnvelope.fromXDR(buffer);
      return decodeTransactionEnvelope(envelope);
    }
    case "TransactionResult": {
      const result = xdr.TransactionResult.fromXDR(buffer);
      return decodeTransactionResult(result);
    }
    case "TransactionMeta": {
      const meta = xdr.TransactionMeta.fromXDR(buffer);
      return decodeTransactionMeta(meta);
    }
    case "LedgerEntry": {
      const entry = xdr.LedgerEntry.fromXDR(buffer);
      return decodeLedgerEntry(entry);
    }
    case "TransactionV1Envelope":
    case "FeeBumpTransaction": {
      // Graceful: decode as TransactionEnvelope and tag appropriately
      try {
        const envelope = xdr.TransactionEnvelope.fromXDR(buffer);
        const decoded = decodeTransactionEnvelope(envelope);
        return {
          ...decoded,
          type: "TransactionEnvelope",
        };
      } catch {
        return {
          type: "TransactionEnvelope",
          tx: { sourceAccount: "unknown", fee: "0", seqNum: "0", operations: [] },
        };
      }
    }
    default:
      throw new Error(`Unsupported XDR type: ${type}`);
  }
}
