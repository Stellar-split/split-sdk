/**
 * Partial-failure handling tests for InvoiceBatchProcessor (#691).
 *
 * These tests verify that:
 *  1. A batch where one invoice throws continues processing remaining invoices.
 *  2. The result object includes `succeeded` and `failed` arrays with correct contents.
 *  3. A batch where all invoices fail returns an empty `succeeded` array.
 */

import { describe, it, expect, vi } from "vitest";
import { InvoiceBatchProcessor } from "../invoiceBatchProcessor.js";
import type { InvoicePaymentSubmitter } from "../invoiceBatchProcessor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drain an async iterator into an array. */
async function drain<T>(iter: AsyncIterableIterator<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of iter) results.push(item);
  return results;
}

// ---------------------------------------------------------------------------
// Tests – partial-failure handling
// ---------------------------------------------------------------------------

describe("InvoiceBatchProcessor – partial-failure handling", () => {
  // ── Criterion 1: one invoice throws, rest continue ───────────────────────

  it("continues processing remaining invoices when one invoice throws", async () => {
    const submitPayment = vi
      .fn()
      .mockImplementation(async ({ invoiceId }: { invoiceId: string }) => {
        if (invoiceId === "inv2") {
          throw new Error("contract call failed");
        }
        return { txHash: `tx-${invoiceId}` };
      });

    const processor = new InvoiceBatchProcessor(
      { submitPayment } as InvoicePaymentSubmitter,
    );

    // Process three invoices: inv1 and inv3 succeed, inv2 fails
    const results = await drain(
      processor.process(["inv1", "inv2", "inv3"], {
        payer: "GPAYER",
        amounts: { inv1: 1n, inv2: 1n, inv3: 1n },
        maxConcurrent: 1, // serial so order is predictable
      }),
    );

    // All three invoices must have been attempted
    expect(results).toHaveLength(3);
    expect(new Set(results.map((r) => r.invoiceId))).toEqual(
      new Set(["inv1", "inv2", "inv3"]),
    );

    // inv1 and inv3 must succeed
    expect(results.find((r) => r.invoiceId === "inv1")!.status).toBe("success");
    expect(results.find((r) => r.invoiceId === "inv3")!.status).toBe("success");

    // inv2 must fail with the error message preserved
    const failed = results.find((r) => r.invoiceId === "inv2")!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("contract call failed");
  });

  // ── Criterion 2: succeeded and failed arrays have correct contents ────────

  it("processAll() returns succeeded and failed arrays with correct contents", async () => {
    const submitPayment = vi
      .fn()
      .mockImplementation(async ({ invoiceId }: { invoiceId: string }) => {
        if (invoiceId === "bad1" || invoiceId === "bad2") {
          throw new Error(`payment rejected: ${invoiceId}`);
        }
        return { txHash: `tx-${invoiceId}` };
      });

    const processor = new InvoiceBatchProcessor(
      { submitPayment } as InvoicePaymentSubmitter,
    );

    const { succeeded, failed } = await processor.processAll(
      ["good1", "bad1", "good2", "bad2", "good3"],
      {
        payer: "GPAYER",
        amounts: {
          good1: 10n,
          bad1: 10n,
          good2: 10n,
          bad2: 10n,
          good3: 10n,
        },
        maxConcurrent: 1,
      },
    );

    // Three invoices succeed
    expect(succeeded).toHaveLength(3);
    expect(new Set(succeeded.map((r) => r.invoiceId))).toEqual(
      new Set(["good1", "good2", "good3"]),
    );
    expect(succeeded.every((r) => r.status === "success")).toBe(true);
    expect(succeeded.every((r) => typeof r.txHash === "string")).toBe(true);

    // Two invoices fail
    expect(failed).toHaveLength(2);
    expect(new Set(failed.map((r) => r.invoiceId))).toEqual(
      new Set(["bad1", "bad2"]),
    );
    expect(failed.every((r) => r.status === "failed")).toBe(true);
    expect(failed.every((r) => typeof r.error === "string")).toBe(true);
  });

  // ── Criterion 3: all invoices fail → empty succeeded array ───────────────

  it("returns an empty succeeded array when all invoices in the batch fail", async () => {
    const submitPayment = vi
      .fn()
      .mockRejectedValue(new Error("network error"));

    const processor = new InvoiceBatchProcessor(
      { submitPayment } as InvoicePaymentSubmitter,
    );

    const { succeeded, failed } = await processor.processAll(
      ["inv1", "inv2", "inv3"],
      {
        payer: "GPAYER",
        amounts: { inv1: 1n, inv2: 1n, inv3: 1n },
        maxConcurrent: 1,
      },
    );

    expect(succeeded).toHaveLength(0);
    expect(failed).toHaveLength(3);
    expect(failed.every((r) => r.status === "failed")).toBe(true);
    expect(failed.every((r) => r.error === "network error")).toBe(true);
  });
});
