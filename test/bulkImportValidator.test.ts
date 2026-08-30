import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { validateBulkImport, SUPPORTED_SCHEMA_VERSIONS } from "../src/bulkImportValidator.js";
import type { BulkImportPayload } from "../src/bulkImportValidator.js";
import type { CreateInvoiceParams } from "../src/types.js";

/** Helper: future deadline (1 hour from now). */
const FUTURE_DEADLINE = Math.floor(Date.now() / 1000) + 3600;

/** Helper: past deadline. */
const PAST_DEADLINE = Math.floor(Date.now() / 1000) - 3600;

function makeRow(overrides: Partial<CreateInvoiceParams> = {}): CreateInvoiceParams {
  return {
    creator: "GABCDEFG1234567890",
    recipients: [{ address: "GXYZ1234567890", amount: 500n }],
    token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    deadline: FUTURE_DEADLINE,
    ...overrides,
  };
}

describe("bulkImportValidator", () => {
  // Use a fake timer so "now" is deterministic for deadline checks.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const stableNow = Math.floor(new Date("2026-01-15T00:00:00Z").getTime() / 1000);
  const futureDeadline = stableNow + 7200;
  const pastDeadline = stableNow - 3600;

  function stableRow(overrides: Partial<CreateInvoiceParams> = {}): CreateInvoiceParams {
    return {
      creator: "GABCDEFG1234567890",
      recipients: [{ address: "GXYZ1234567890", amount: 500n }],
      token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      deadline: futureDeadline,
      ...overrides,
    };
  }

  // -----------------------------------------------------------------------
  // All-valid set
  // -----------------------------------------------------------------------
  describe("all-valid set", () => {
    it("returns all indices as valid when every row is correct", () => {
      const rows = [
        stableRow(),
        stableRow({
          recipients: [
            { address: "GA1", amount: 100n },
            { address: "GA2", amount: 200n },
          ],
        }),
        stableRow({ memo: "invoice #3" }),
      ];

      const result = validateBulkImport(rows);

      expect(result.validRows).toEqual([0, 1, 2]);
      expect(result.errors).toEqual([]);
    });

    it("handles a single valid row", () => {
      const result = validateBulkImport([stableRow()]);
      expect(result.validRows).toEqual([0]);
      expect(result.errors).toHaveLength(0);
    });

    it("handles an empty input array", () => {
      const result = validateBulkImport([]);
      expect(result.validRows).toEqual([]);
      expect(result.errors).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // All-invalid set
  // -----------------------------------------------------------------------
  describe("all-invalid set", () => {
    it("returns no valid rows and collects errors for every row", () => {
      const rows = [
        stableRow({ recipients: [] }), // empty recipients
        stableRow({
          recipients: [{ address: "GA1", amount: 0n }], // zero amount
        }),
        stableRow({ deadline: pastDeadline }), // past deadline
        stableRow({
          recipients: [{ address: "GA1", amount: -10n }], // negative amount
          deadline: pastDeadline, // and also past deadline
        }),
      ];

      const result = validateBulkImport(rows);

      expect(result.validRows).toEqual([]);
      expect(result.errors.length).toBeGreaterThanOrEqual(4);

      // Row 0: empty recipients
      expect(result.errors).toContainEqual(
        expect.objectContaining({ row: 0, field: "recipients" }),
      );
      // Row 1: zero amount
      expect(result.errors).toContainEqual(
        expect.objectContaining({ row: 1, field: "recipients[0].amount" }),
      );
      // Row 2: past deadline
      expect(result.errors).toContainEqual(
        expect.objectContaining({ row: 2, field: "deadline" }),
      );
      // Row 3: negative amount AND past deadline
      expect(result.errors).toContainEqual(
        expect.objectContaining({ row: 3, field: "recipients[0].amount" }),
      );
      expect(result.errors).toContainEqual(
        expect.objectContaining({ row: 3, field: "deadline" }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Mixed set with multiple distinct error rows
  // -----------------------------------------------------------------------
  describe("mixed set with distinct error rows", () => {
    it("reports errors only for invalid rows and marks the rest valid", () => {
      const rows = [
        stableRow(), // valid (idx 0)
        stableRow({ recipients: [] }), // invalid (idx 1)
        stableRow(), // valid (idx 2)
        stableRow({
          recipients: [
            { address: "GA1", amount: 100n },
            { address: "GA2", amount: -5n }, // second recipient negative
          ],
        }), // invalid (idx 3)
        stableRow({ deadline: pastDeadline }), // invalid (idx 4)
        stableRow({ memo: "all good here" }), // valid (idx 5)
      ];

      const result = validateBulkImport(rows);

      expect(result.validRows).toEqual([0, 2, 5]);
      expect(result.errors).toHaveLength(3);

      // row 1 error
      expect(result.errors[0]).toEqual(
        expect.objectContaining({ row: 1, field: "recipients" }),
      );
      // row 3 error – specifically the second recipient
      expect(result.errors[1]).toEqual(
        expect.objectContaining({ row: 3, field: "recipients[1].amount" }),
      );
      // row 4 error
      expect(result.errors[2]).toEqual(
        expect.objectContaining({ row: 4, field: "deadline" }),
      );
    });

    it("continues past early errors to validate later rows", () => {
      const rows = [
        stableRow({ deadline: pastDeadline }), // invalid first row
        stableRow(), // valid second row
      ];

      const result = validateBulkImport(rows);

      expect(result.validRows).toEqual([1]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].row).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Edge-case: multiple errors on a single row
  // -----------------------------------------------------------------------
  describe("multiple errors on a single row", () => {
    it("reports all errors for a row with both bad amount and bad deadline", () => {
      const rows = [
        stableRow({
          recipients: [{ address: "GA1", amount: 0n }],
          deadline: pastDeadline,
        }),
      ];

      const result = validateBulkImport(rows);

      expect(result.validRows).toEqual([]);
      expect(result.errors).toHaveLength(2);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ row: 0, field: "recipients[0].amount" }),
      );
      expect(result.errors).toContainEqual(
        expect.objectContaining({ row: 0, field: "deadline" }),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// schemaVersion validation (SUPPORTED_SCHEMA_VERSIONS)
// ---------------------------------------------------------------------------
describe("schemaVersion validation", () => {
  const stableNow2 = Math.floor(new Date("2026-01-15T00:00:00Z").getTime() / 1000);
  const futureDeadline2 = stableNow2 + 7200;

  function payloadRow(overrides: Partial<CreateInvoiceParams> = {}): CreateInvoiceParams {
    return {
      creator: "GABCDEFG1234567890",
      recipients: [{ address: "GXYZ1234567890", amount: 500n }],
      token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      deadline: futureDeadline2,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exports SUPPORTED_SCHEMA_VERSIONS containing 1 and 2", () => {
    expect(SUPPORTED_SCHEMA_VERSIONS).toContain(1);
    expect(SUPPORTED_SCHEMA_VERSIONS).toContain(2);
  });

  it("accepts a versioned payload with schemaVersion 1", () => {
    const payload: BulkImportPayload = {
      schemaVersion: 1,
      rows: [payloadRow()],
    };
    const result = validateBulkImport(payload);
    expect(result.errors).toHaveLength(0);
    expect(result.validRows).toEqual([0]);
  });

  it("accepts a versioned payload with schemaVersion 2", () => {
    const payload: BulkImportPayload = {
      schemaVersion: 2,
      rows: [payloadRow()],
    };
    const result = validateBulkImport(payload);
    expect(result.errors).toHaveLength(0);
    expect(result.validRows).toEqual([0]);
  });

  it("rejects an unsupported schemaVersion with a descriptive error", () => {
    const payload: BulkImportPayload = {
      schemaVersion: 99,
      rows: [payloadRow()],
    };
    const result = validateBulkImport(payload);
    expect(result.validRows).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].field).toBe("schemaVersion");
    expect(result.errors[0].message).toMatch(/99/);
    expect(result.errors[0].message).toMatch(/Supported/i);
  });

  it("rejects schemaVersion 0 (not in supported list)", () => {
    const payload: BulkImportPayload = {
      schemaVersion: 0,
      rows: [payloadRow()],
    };
    const result = validateBulkImport(payload);
    expect(result.errors[0].field).toBe("schemaVersion");
  });

  it("still validates rows normally when schemaVersion is valid", () => {
    const payload: BulkImportPayload = {
      schemaVersion: 1,
      rows: [
        payloadRow(),                                          // valid
        payloadRow({ recipients: [] }),                        // invalid
      ],
    };
    const result = validateBulkImport(payload);
    expect(result.validRows).toEqual([0]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ row: 1, field: "recipients" });
  });

  it("raw array (no schemaVersion) continues to work unchanged", () => {
    const result = validateBulkImport([payloadRow(), payloadRow()]);
    expect(result.validRows).toEqual([0, 1]);
    expect(result.errors).toHaveLength(0);
  });
});
