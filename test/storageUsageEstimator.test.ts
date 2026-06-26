import { describe, it, expect } from "vitest";
import {
  estimateStorageFootprint,
} from "../src/storageUsageEstimator.js";

// Derived from the implementation constants:
//   LEDGER_ENTRY_OVERHEAD = 40
//   coreBytes             = 8 + 32 + 32 + 8 + 16 + 4 = 100
//   1 recipient           = 32 + 16 = 48
//   baseline (1 invoice, 1 recipient) = 40 + 100 + 48 = 188
const BASELINE_BYTES = 188;
const STROOPS_PER_BYTE_PER_YEAR = 6_307;

describe("estimateStorageFootprint", () => {
  it("baseline: single invoice, 1 recipient", () => {
    const result = estimateStorageFootprint(1, {});
    expect(result.bytesPerInvoice).toBe(BASELINE_BYTES);
    expect(result.totalBytes).toBe(BASELINE_BYTES);
    expect(result.estimatedRentStroops).toBe(BASELINE_BYTES * STROOPS_PER_BYTE_PER_YEAR);
  });

  it("linear batch: footprint scales linearly with invoiceCount", () => {
    const single = estimateStorageFootprint(1, {});
    const batch5 = estimateStorageFootprint(5, {});
    const batch10 = estimateStorageFootprint(10, {});

    expect(batch5.totalBytes).toBe(single.bytesPerInvoice * 5);
    expect(batch10.totalBytes).toBe(single.bytesPerInvoice * 10);
    expect(batch10.estimatedRentStroops).toBe(batch10.totalBytes * STROOPS_PER_BYTE_PER_YEAR);
  });

  it("feature increment: 3 tranches adds 3 × 20 bytes per invoice", () => {
    const base = estimateStorageFootprint(1, {});
    const withTranches = estimateStorageFootprint(1, { tranches: 3 });

    expect(withTranches.bytesPerInvoice).toBe(base.bytesPerInvoice + 3 * 20);
    expect(withTranches.estimatedRentStroops).toBe(
      withTranches.totalBytes * STROOPS_PER_BYTE_PER_YEAR
    );
  });

  it("feature increment: 2 co-signers adds 2 × 32 bytes per invoice", () => {
    const base = estimateStorageFootprint(1, {});
    const withCoSigners = estimateStorageFootprint(1, { coSigners: 2 });

    expect(withCoSigners.bytesPerInvoice).toBe(base.bytesPerInvoice + 2 * 32);
  });

  it("feature increment: combined 3 tranches + 2 co-signers compounds correctly", () => {
    // 188 + (3 * 20) + (2 * 32) = 188 + 60 + 64 = 312
    const result = estimateStorageFootprint(1, { tranches: 3, coSigners: 2 });
    expect(result.bytesPerInvoice).toBe(312);
    expect(result.estimatedRentStroops).toBe(312 * STROOPS_PER_BYTE_PER_YEAR);
  });

  it("multiple recipients scale the per-invoice byte count correctly", () => {
    const single = estimateStorageFootprint(1, { recipientsPerInvoice: 1 });
    const triple = estimateStorageFootprint(1, { recipientsPerInvoice: 3 });

    // Each extra recipient adds 48 bytes (32 address + 16 amount)
    expect(triple.bytesPerInvoice).toBe(single.bytesPerInvoice + 2 * 48);
  });

  it("throws for invoiceCount < 1", () => {
    expect(() => estimateStorageFootprint(0, {})).toThrow(RangeError);
    expect(() => estimateStorageFootprint(-1, {})).toThrow(RangeError);
  });
});
