/**
 * Typed XDR envelope parser.
 *
 * The SDK submits transactions as opaque XDR blobs but previously did not
 * expose a utility to decode an envelope back into a structured,
 * human-readable object for debugging, audit logging, or UI display.
 *
 * This module decodes any base64-encoded {@link xdr.TransactionEnvelope} and
 * returns a structured representation of its operations, signers, source
 * account, sequence number, memo, fee, and time bounds.
 */

import {
  xdr,
  Operation,
  Memo,
  StrKey,
} from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Decoded representation of a single operation within a transaction. */
export interface ParsedOperation {
  /** Human-readable operation type (e.g. "payment", "manageSellOffer"). */
  type: string;
  /** The raw operation body as a JSON-serialisable object. */
  body: Record<string, unknown>;
  /** Optional source account override for this operation. */
  source?: string;
}

/** Structured representation of a decoded transaction envelope. */
export interface ParsedEnvelope {
  /** Base64-encoded source XDR that was parsed. */
  sourceXdr: string;
  /** Envelope type (e.g. "envelope_type_tx", "envelope_type_tx_v0", "envelope_type_tx_fee_bump"). */
  envelopeType: string;
  /** Parsed transaction body. */
  transaction: ParsedTransaction;
  /** List of signatures attached to the envelope. */
  signatures: ParsedSignature[];
}

/** Parsed representation of the inner transaction. */
export interface ParsedTransaction {
  /** Source account public key (G...). */
  sourceAccount: string;
  /** Sequence number. */
  sequence: bigint;
  /** Fee in stroops. */
  fee: number;
  /** Parsed memo, if present. */
  memo: ParsedMemo | null;
  /** Ordered list of operations. */
  operations: ParsedOperation[];
  /** Time bounds, if set. */
  timeBounds?: ParsedTimeBounds;
}

/** Parsed memo representation. */
export interface ParsedMemo {
  /** Memo type (e.g. "id", "text", "hash", "return", "none"). */
  type: string;
  /** Memo value, stringified for readability. */
  value: string | null;
}

/** Parsed signature. */
export interface ParsedSignature {
  /** Hex-encoded signature hint (last 4 bytes of the public key). */
  hint: string;
  /** Hex-encoded signature bytes. */
  signature: string;
}

/** Decoded time bounds. */
export interface ParsedTimeBounds {
  /** Minimum time bound (Unix timestamp), or 0 if no lower bound. */
  minTime: number;
  /** Maximum time bound (Unix timestamp), or 0 if no upper bound. */
  maxTime: number;
}

// ---------------------------------------------------------------------------\
// Implementation
// ---------------------------------------------------------------------------\

/**
 * Parse a base64-encoded Stellar transaction envelope XDR into a structured,
 * human-readable object.
 *
 * @param xdrBase64 - Base64-encoded transaction envelope XDR string.
 * @returns A parsed representation of the envelope.
 * @throws If the XDR string cannot be decoded or is of an unknown type.
 */
export function parseEnvelope(xdrBase64: string): ParsedEnvelope {
  const envelope = xdr.TransactionEnvelope.fromXDR(xdrBase64, "base64");

  const parsed: ParsedEnvelope = {
    sourceXdr: xdrBase64,
    envelopeType: envelope.switch().name,
    transaction: {
      sourceAccount: "",
      sequence: 0n,
      fee: 0,
      memo: null,
      operations: [],
    },
    signatures: [],
  };

  switch (envelope.switch().name) {
    case "envelopeTypeTxV0": {
      const v0 = envelope.v0();
      const tx: any = v0.tx();
      parsed.transaction = parseTxInner(
        tx.sourceAccountEd25519(),
        tx.seqNum(),
        tx.fee(),
        tx.memo(),
        tx.operations(),
        tx.timeBounds(),
      );
      parsed.signatures = parseSignatures(v0.signatures());
      break;
    }
    case "envelopeTypeTx": {
      const v1 = envelope.v1();
      const tx: any = v1.tx();
      parsed.transaction = parseTxInner(
        tx.sourceAccount(),
        tx.seqNum(),
        tx.fee(),
        tx.memo(),
        tx.operations(),
        tx.timeBounds(),
      );
      parsed.signatures = parseSignatures(v1.signatures());
      break;
    }
    case "envelopeTypeTxFeeBump": {
      const fb = envelope.feeBump();
      const innerTx: any = fb.tx().innerTx().v1().tx();
      parsed.transaction = parseTxInner(
        innerTx.sourceAccount(),
        innerTx.seqNum(),
        innerTx.fee(),
        innerTx.memo(),
        innerTx.operations(),
        innerTx.timeBounds(),
      );
      parsed.signatures = parseSignatures(fb.signatures());
      parsed.envelopeType = "envelope_type_tx_fee_bump";
      break;
    }
    default:
      throw new Error(
        `Unsupported envelope type: ${envelope.switch().name}`,
      );
  }

  return parsed;
}

/** Parse the inner transaction fields common to all envelope variants. */
function parseTxInner(
  sourceAccount: any,
  seqNum: any,
  fee: any,
  memo: any,
  operations: any[],
  timeBounds: any | null,
): ParsedTransaction {
  let sourceAccountStr = "<unknown>";
  try {
    const ed25519 = typeof sourceAccount.ed25519 === "function"
      ? sourceAccount.ed25519()
      : sourceAccount;
    sourceAccountStr = bytesToStrKey(ed25519);
  } catch {
    // ignore
  }

  return {
    sourceAccount: sourceAccountStr,
    sequence: BigInt(String(seqNum)),
    fee: Number(fee),
    memo: parseMemo(memo),
    operations: parseOps(operations),
    timeBounds: timeBounds ? parseTimeBounds(timeBounds) : undefined,
  };
}

/** Convert raw ed25519 bytes to a Stellar StrKey (base32). */
function bytesToStrKey(raw: Buffer | Uint8Array): string {
  try {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    return StrKey.encodeEd25519PublicKey(buf);
  } catch {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    return `G${buf.toString("hex").substring(0, 54)}`;
  }
}

/** Parse memo from XDR. */
function parseMemo(memo: any): ParsedMemo | null {
  try {
    const m = Memo.fromXDRObject(memo);
    return {
      type: m.type,
      value: m.value?.toString() ?? null,
    };
  } catch {
    return { type: "unknown", value: null };
  }
}

/** Parse an array of XDR operations. */
function parseOps(ops: any[]): ParsedOperation[] {
  return ops.map((op) => {
    try {
      const parsed = Operation.fromXDRObject(op) as unknown as Record<string, unknown>;
      return {
        type: (parsed.type as string) ?? "unknown",
        body: sanitiseBody(parsed),
        source: parsed.source as string | undefined,
      };
    } catch {
      return { type: "unknown", body: {} };
    }
  });
}

/** Strip circular / non-serialisable values from operation body. */
function sanitiseBody(op: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const key of Object.keys(op)) {
    const val = op[key];
    if (val === null || val === undefined) continue;
    if (typeof val === "bigint") {
      cleaned[key] = val.toString();
    } else if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
      cleaned[key] = val;
    } else if (Buffer.isBuffer(val)) {
      cleaned[key] = (val as Buffer).toString("base64");
    } else if (Array.isArray(val)) {
      cleaned[key] = val.map((v: unknown) =>
        typeof v === "string" || typeof v === "number" ? v : "[object]",
      );
    } else {
      cleaned[key] = "[object]";
    }
  }
  return cleaned;
}

/** Parse signatures from XDR. */
function parseSignatures(
  sigs: { hint(): Buffer; signature(): Buffer }[],
): ParsedSignature[] {
  return sigs.map((ds) => ({
    hint: Buffer.from(ds.hint()).toString("hex"),
    signature: Buffer.from(ds.signature()).toString("hex"),
  }));
}

/** Parse time bounds. */
function parseTimeBounds(tb: any): ParsedTimeBounds {
  return {
    minTime: Number(tb.minTime()),
    maxTime: Number(tb.maxTime()),
  };
}
