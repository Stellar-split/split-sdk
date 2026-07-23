/**
 * Invoice payment dispute evidence bundler.
 *
 * Aggregates payment proof, on-chain audit log, and event history into a
 * tamper-evident bundle secured by a top-level SHA-256 checksum.
 */

import { createHash } from "crypto";
import type { PaymentProof } from "./proof.js";
import type { AuditEntry } from "./auditLogger.js";
import type { ContractEvent } from "./events.js";
import { DisputeEvidenceError } from "./errors.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DisputeEvidenceBundle {
  invoiceId: string;
  payer: string | undefined;
  proof: PaymentProof | null;
  auditLog: AuditEntry[];
  events: ContractEvent[];
  /** SHA-256 hex checksum of the serialised proof + auditLog + events payload. */
  checksum: string;
}

/** Injectable fetcher types for the three evidence sources. */
export type ProofFetcher = (invoiceId: string, payer?: string) => Promise<PaymentProof | null>;
export type AuditLogFetcher = (invoiceId: string) => Promise<AuditEntry[]>;
export type EventFetcher = (invoiceId: string) => Promise<ContractEvent[]>;

// ---------------------------------------------------------------------------
// Injectable source registry (mirrors enricher.ts pattern)
// ---------------------------------------------------------------------------

let _proofFetcher: ProofFetcher | null = null;
let _auditLogFetcher: AuditLogFetcher | null = null;
let _eventFetcher: EventFetcher | null = null;

export function registerProofFetcher(f: ProofFetcher): void {
  _proofFetcher = f;
}

export function registerAuditLogFetcher(f: AuditLogFetcher): void {
  _auditLogFetcher = f;
}

export function registerEventFetcher(f: EventFetcher): void {
  _eventFetcher = f;
}

// ---------------------------------------------------------------------------
// Checksum helper
// ---------------------------------------------------------------------------

/** Compute a SHA-256 hex checksum over the three evidence payload sections. */
export function computeBundleChecksum(
  proof: PaymentProof | null,
  auditLog: AuditEntry[],
  events: ContractEvent[]
): string {
  const payload = JSON.stringify(
    { proof, auditLog, events },
    (_key, value) => (typeof value === "bigint" ? value.toString() : value)
  );
  return createHash("sha256").update(payload).digest("hex");
}

/** Verify that a bundle's checksum matches its payload. */
export function verifyBundleChecksum(bundle: DisputeEvidenceBundle): boolean {
  const expected = computeBundleChecksum(bundle.proof, bundle.auditLog, bundle.events);
  return bundle.checksum === expected;
}

// ---------------------------------------------------------------------------
// Primary entry point
// ---------------------------------------------------------------------------

/**
 * Collect and bundle dispute evidence for an invoice.
 *
 * Requires at least one registered fetcher per source before calling.
 *
 * @param invoiceId - On-chain invoice ID.
 * @param payer     - Optional payer address to scope proof generation.
 * @returns A tamper-evident evidence bundle.
 */
export async function bundleDisputeEvidence(
  invoiceId: string,
  payer?: string
): Promise<DisputeEvidenceBundle> {
  if (!_proofFetcher || !_auditLogFetcher || !_eventFetcher) {
    throw new DisputeEvidenceError(
      "All three fetchers must be registered before calling bundleDisputeEvidence. " +
        "Call registerProofFetcher, registerAuditLogFetcher, and registerEventFetcher first."
    );
  }

  const [proof, auditLog, events] = await Promise.all([
    _proofFetcher(invoiceId, payer),
    _auditLogFetcher(invoiceId),
    _eventFetcher(invoiceId),
  ]);

  const checksum = computeBundleChecksum(proof, auditLog, events);

  return { invoiceId, payer, proof, auditLog, events, checksum };
}