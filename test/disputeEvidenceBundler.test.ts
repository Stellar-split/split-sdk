import { describe, it, expect, beforeEach } from "vitest";
import {
  bundleDisputeEvidence,
  computeBundleChecksum,
  verifyBundleChecksum,
  registerProofFetcher,
  registerAuditLogFetcher,
  registerEventFetcher,
} from "../src/disputeEvidenceBundler.js";
import type { PaymentProof } from "../src/proof.js";
import type { AuditEntry } from "../src/auditLogger.js";
import type { ContractEvent } from "../src/events.js";

const INVOICE_ID = "42";
const PAYER = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

const mockProof: PaymentProof = {
  txHash: "abc123",
  payer: PAYER,
  invoiceId: INVOICE_ID,
  amount: 5_000_000n,
  ledger: 1001,
  proofHash: "deadbeef",
};

const mockAuditLog: AuditEntry[] = [
  { timestamp: 1_700_000_000, method: "pay", params: { invoiceId: INVOICE_ID }, success: true, durationMs: 120 },
];

const mockEvents: ContractEvent[] = [
  { type: "payment", invoiceId: INVOICE_ID, data: { amount: 5_000_000 }, ledger: 1001, timestamp: 1_700_000_000 },
];

beforeEach(() => {
  registerProofFetcher(async () => mockProof);
  registerAuditLogFetcher(async () => mockAuditLog);
  registerEventFetcher(async () => mockEvents);
});

describe("bundleDisputeEvidence", () => {
  it("completeness: bundle contains proof, auditLog, and events", async () => {
    const bundle = await bundleDisputeEvidence(INVOICE_ID, PAYER);

    expect(bundle.proof).toBeDefined();
    expect(bundle.auditLog).toBeDefined();
    expect(bundle.events).toBeDefined();
    expect(bundle.proof).toEqual(mockProof);
    expect(bundle.auditLog).toEqual(mockAuditLog);
    expect(bundle.events).toEqual(mockEvents);
  });

  it("integrity: checksum validates an unaltered bundle", async () => {
    const bundle = await bundleDisputeEvidence(INVOICE_ID, PAYER);
    expect(verifyBundleChecksum(bundle)).toBe(true);
  });

  it("tamper rejection: mutating a proof field breaks checksum", async () => {
    const bundle = await bundleDisputeEvidence(INVOICE_ID, PAYER);
    const tampered = {
      ...bundle,
      proof: bundle.proof ? { ...bundle.proof, txHash: "tampered" } : null,
    };
    expect(verifyBundleChecksum(tampered)).toBe(false);
  });

  it("tamper rejection: mutating an audit log entry breaks checksum", async () => {
    const bundle = await bundleDisputeEvidence(INVOICE_ID, PAYER);
    const tampered = {
      ...bundle,
      auditLog: [{ ...bundle.auditLog[0]!, timestamp: 9_999_999_999 }],
    };
    expect(verifyBundleChecksum(tampered)).toBe(false);
  });

  it("tamper rejection: mutating an event ledger sequence breaks checksum", async () => {
    const bundle = await bundleDisputeEvidence(INVOICE_ID, PAYER);
    const tampered = {
      ...bundle,
      events: [{ ...bundle.events[0]!, ledger: 99999 }],
    };
    expect(verifyBundleChecksum(tampered)).toBe(false);
  });

  it("computeBundleChecksum is deterministic across calls", () => {
    const c1 = computeBundleChecksum(mockProof, mockAuditLog, mockEvents);
    const c2 = computeBundleChecksum(mockProof, mockAuditLog, mockEvents);
    expect(c1).toBe(c2);
    expect(c1).toHaveLength(64);
  });
});
