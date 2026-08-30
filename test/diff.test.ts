/**
 * Tests for three-way merge conflict detection in src/diff.ts — issue #703.
 *
 * Covers:
 *  - Both branches modify the same field → MergeConflict thrown with the field name
 *  - Only one branch modifies a field → merge succeeds with the modified value
 *  - Neither branch modifies a field → merge succeeds with the base value
 */

import { describe, it, expect } from "vitest";
import { mergeInvoices } from "../src/diff.js";
import { MergeConflictError } from "../src/errors.js";
import type { Invoice } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "inv-1",
    creator: "GCREATOR000000000000000000000000000000000000000000000",
    recipients: [{ address: "GRECIPIENT0000000000000000000000000000000000000000000", amount: 1_000_000n }],
    token: "USDC_CONTRACT",
    deadline: 2_000_000_000,
    funded: 0n,
    status: "Pending",
    payments: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Three-way merge: conflict detection
// ---------------------------------------------------------------------------

describe("mergeInvoices — conflict detection", () => {
  it("throws MergeConflictError when both branches modify the same field to different values", () => {
    const base   = makeInvoice({ memo: "original memo" });
    const local  = makeInvoice({ memo: "local memo" });
    const remote = makeInvoice({ memo: "remote memo" });

    expect(() => mergeInvoices(base, local, remote)).toThrow(MergeConflictError);
  });

  it("includes the conflicting field name in the thrown error", () => {
    const base   = makeInvoice({ memo: "original" });
    const local  = makeInvoice({ memo: "local edit" });
    const remote = makeInvoice({ memo: "remote edit" });

    let caught: unknown;
    try {
      mergeInvoices(base, local, remote);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MergeConflictError);
    expect((caught as MergeConflictError).field).toBe("memo");
  });

  it("includes base, local, and remote values in the thrown error", () => {
    const base   = makeInvoice({ deadline: 1_000_000 });
    const local  = makeInvoice({ deadline: 1_100_000 });
    const remote = makeInvoice({ deadline: 1_200_000 });

    let caught: unknown;
    try {
      mergeInvoices(base, local, remote);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MergeConflictError);
    const err = caught as MergeConflictError;
    expect(err.baseValue).toBe(1_000_000);
    expect(err.localValue).toBe(1_100_000);
    expect(err.remoteValue).toBe(1_200_000);
  });

  it("throws on the first conflicting field encountered", () => {
    // Both status and memo conflict; error should fire on one of them.
    const base   = makeInvoice({ status: "Pending", memo: "base" });
    const local  = makeInvoice({ status: "Released", memo: "local" });
    const remote = makeInvoice({ status: "Refunded", memo: "remote" });

    expect(() => mergeInvoices(base, local, remote)).toThrow(MergeConflictError);
  });

  it("does NOT throw when both branches set the same field to the same value", () => {
    // Both converge on the same memo — not a conflict.
    const base   = makeInvoice({ memo: "original" });
    const local  = makeInvoice({ memo: "agreed value" });
    const remote = makeInvoice({ memo: "agreed value" });

    const merged = mergeInvoices(base, local, remote);
    expect(merged.memo).toBe("agreed value");
  });

  it("correctly identifies the field name for bigint fields in conflict error", () => {
    const base   = makeInvoice({ funded: 0n });
    const local  = makeInvoice({ funded: 500_000n });
    const remote = makeInvoice({ funded: 700_000n });

    let caught: unknown;
    try {
      mergeInvoices(base, local, remote);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MergeConflictError);
    expect((caught as MergeConflictError).field).toBe("funded");
  });
});

// ---------------------------------------------------------------------------
// Three-way merge: one branch modifies a field
// ---------------------------------------------------------------------------

describe("mergeInvoices — one branch modifies a field", () => {
  it("takes the local value when only local modified the field", () => {
    const base   = makeInvoice({ memo: "base memo" });
    const local  = makeInvoice({ memo: "updated by local" });
    const remote = makeInvoice({ memo: "base memo" }); // unchanged

    const merged = mergeInvoices(base, local, remote);

    expect(merged.memo).toBe("updated by local");
  });

  it("takes the remote value when only remote modified the field", () => {
    const base   = makeInvoice({ status: "Pending" });
    const local  = makeInvoice({ status: "Pending" }); // unchanged
    const remote = makeInvoice({ status: "Released" });

    const merged = mergeInvoices(base, local, remote);

    expect(merged.status).toBe("Released");
  });

  it("preserves all other unchanged fields when only one field is modified", () => {
    const base   = makeInvoice({ memo: "base", deadline: 1_000_000 });
    const local  = makeInvoice({ memo: "updated", deadline: 1_000_000 });
    const remote = makeInvoice({ memo: "base", deadline: 1_000_000 });

    const merged = mergeInvoices(base, local, remote);

    expect(merged.memo).toBe("updated");
    expect(merged.deadline).toBe(1_000_000);
    expect(merged.id).toBe(base.id);
    expect(merged.creator).toBe(base.creator);
    expect(merged.status).toBe(base.status);
  });

  it("applies a local bigint change (funded amount) without conflict", () => {
    const base   = makeInvoice({ funded: 0n });
    const local  = makeInvoice({ funded: 1_000_000n });
    const remote = makeInvoice({ funded: 0n }); // unchanged

    const merged = mergeInvoices(base, local, remote);

    expect(merged.funded).toBe(1_000_000n);
  });

  it("applies a remote bigint change without conflict", () => {
    const base   = makeInvoice({ funded: 0n });
    const local  = makeInvoice({ funded: 0n }); // unchanged
    const remote = makeInvoice({ funded: 2_000_000n });

    const merged = mergeInvoices(base, local, remote);

    expect(merged.funded).toBe(2_000_000n);
  });

  it("handles an optional field added only by local (undefined → value)", () => {
    const base   = makeInvoice();          // memo is undefined
    const local  = makeInvoice({ memo: "new memo" });
    const remote = makeInvoice();          // still undefined

    const merged = mergeInvoices(base, local, remote);

    expect(merged.memo).toBe("new memo");
  });

  it("handles an optional field added only by remote (undefined → value)", () => {
    const base   = makeInvoice();
    const local  = makeInvoice();
    const remote = makeInvoice({ memo: "remote memo" });

    const merged = mergeInvoices(base, local, remote);

    expect(merged.memo).toBe("remote memo");
  });
});

// ---------------------------------------------------------------------------
// Three-way merge: neither branch modifies a field
// ---------------------------------------------------------------------------

describe("mergeInvoices — neither branch modifies a field", () => {
  it("retains the base value when neither branch changed the field", () => {
    const base   = makeInvoice({ memo: "base memo" });
    const local  = makeInvoice({ memo: "base memo" }); // same as base
    const remote = makeInvoice({ memo: "base memo" }); // same as base

    const merged = mergeInvoices(base, local, remote);

    expect(merged.memo).toBe("base memo");
  });

  it("retains the base bigint value when neither branch changed it", () => {
    const base   = makeInvoice({ funded: 500n });
    const local  = makeInvoice({ funded: 500n });
    const remote = makeInvoice({ funded: 500n });

    const merged = mergeInvoices(base, local, remote);

    expect(merged.funded).toBe(500n);
  });

  it("returns a merged invoice that is structurally equal to the base when nothing changed", () => {
    const base   = makeInvoice({ memo: "unchanged", status: "Pending", deadline: 9_999_999 });
    const local  = { ...base };
    const remote = { ...base };

    const merged = mergeInvoices(base, local, remote);

    expect(merged.memo).toBe(base.memo);
    expect(merged.status).toBe(base.status);
    expect(merged.deadline).toBe(base.deadline);
    expect(merged.funded).toBe(base.funded);
    expect(merged.id).toBe(base.id);
  });

  it("retains an undefined optional field when neither branch set it", () => {
    const base   = makeInvoice(); // memo is undefined
    const local  = makeInvoice();
    const remote = makeInvoice();

    const merged = mergeInvoices(base, local, remote);

    expect(merged.memo).toBeUndefined();
  });
});
