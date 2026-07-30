import { truncateAddress } from "./utils.js";
import { decodeXDR } from "./xdrDecoder.js";
import type { XDRType, DecodedXDR, SplitAuditEntry } from "./types.js";

export interface AuditEntry {
  timestamp: number;
  method: string;
  params: Record<string, unknown>;
  success: boolean;
  durationMs: number;
  /** Optional decoded XDR payload attached to this audit entry. */
  decodedXdr?: DecodedXDR;
}

const STELLAR_ADDRESS_RE = /^G[A-Z0-9]{55}$/;

/** Detect if a string value looks like base64-encoded XDR. */
const XDR_BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Heuristic minimum length for XDR base64 strings (at least ~40 chars for a minimal tx). */
const MIN_XDR_LENGTH = 40;

export class AuditLogger {
  private readonly sink: (entry: AuditEntry) => void;
  private readonly splitAuditTrails = new Map<string, SplitAuditEntry[]>();

  constructor(sink: (entry: AuditEntry) => void) {
    this.sink = sink;
  }

  log(entry: AuditEntry): void {
    this.sink(entry);
  }

  sanitize(params: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(params).map(([k, v]) => [
        k,
        typeof v === "string" && STELLAR_ADDRESS_RE.test(v)
          ? truncateAddress(v)
          : v,
      ])
    );
  }

  /**
   * Log an entry with automatic XDR decoding.
   *
   * When `xdrPayload` is provided, it is decoded and attached as `decodedXdr`.
   * This produces structured JSON safe for log aggregation, audit trails,
   * and developer UIs — no external XDR converters needed.
   *
   * @param entry     - Base audit entry.
   * @param xdrPayload - Base64-encoded XDR to decode (e.g. a transaction envelope).
   * @param xdrType    - The expected XDR type.
   */
  logWithXdr(
    entry: AuditEntry,
    xdrPayload: string,
    xdrType: XDRType,
  ): void {
    try {
      if (
        xdrPayload.length >= MIN_XDR_LENGTH &&
        XDR_BASE64_RE.test(xdrPayload)
      ) {
        entry.decodedXdr = decodeXDR(xdrPayload, xdrType);
      }
    } catch {
      // Decoding best-effort; never fail an audit log write.
    }
    this.log(entry);
  }

  /**
   * Auto-detect and decode XDR payloads embedded in audit params.
   *
   * Scans `entry.params` for keys matching known XDR field names
   * ("xdr", "txXdr", "envelopeXdr", "resultXdr", "metaXdr")
   * and attempts to decode them, attaching the result to `entry.decodedXdr`.
   */
  logAndDecodeXdr(entry: AuditEntry): void {
    const xdrKeys: Array<{ key: string; type: XDRType }> = [
      { key: "xdr", type: "TransactionEnvelope" },
      { key: "txXdr", type: "TransactionEnvelope" },
      { key: "envelopeXdr", type: "TransactionEnvelope" },
      { key: "resultXdr", type: "TransactionResult" },
      { key: "metaXdr", type: "TransactionMeta" },
    ];

    for (const { key, type } of xdrKeys) {
      const value = entry.params[key];
      if (typeof value === "string" && value.length >= MIN_XDR_LENGTH) {
        try {
          entry.decodedXdr = decodeXDR(value, type);
          break; // Decode the first match only
        } catch {
          // continue to next key
        }
      }
    }

    this.log(entry);
  }

  /**
   * Record a `SplitAuditEntry` for a single settled leg of a multi-recipient
   * split payment. Writes immediately to the configured sink (as an
   * `AuditEntry`) and to the in-memory per-invoice trail returned by
   * {@link exportSplitAuditTrail}.
   */
  recordSplitLeg(entry: SplitAuditEntry): void {
    const trail = this.splitAuditTrails.get(entry.invoiceId) ?? [];
    trail.push(entry);
    this.splitAuditTrails.set(entry.invoiceId, trail);

    this.log({
      timestamp: entry.settledAt,
      method: "split_leg_settled",
      params: this.sanitize({
        invoiceId: entry.invoiceId,
        legIndex: entry.legIndex,
        recipientId: entry.recipientId,
        assetCode: entry.assetCode,
        amount: entry.amount.toString(),
        operationId: entry.operationId,
        ledgerSequence: entry.ledgerSequence,
      }),
      success: true,
      durationMs: 0,
    });
  }

  /**
   * Return all recorded `SplitAuditEntry` records for `invoiceId`, in the
   * order they were settled.
   */
  async exportSplitAuditTrail(invoiceId: string): Promise<SplitAuditEntry[]> {
    return [...(this.splitAuditTrails.get(invoiceId) ?? [])];
  }
}
