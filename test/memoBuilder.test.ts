import { describe, it, expect } from "vitest";
import { buildPaymentMemo, parsePaymentMemo } from "../src/memoBuilder.js";

describe("buildPaymentMemo", () => {
  it("returns split:{invoiceId} for base format", () => {
    expect(buildPaymentMemo("inv-123")).toBe("split:inv-123");
  });

  it("returns split:{invoiceId}:t{tranche} when tranche is provided", () => {
    expect(buildPaymentMemo("inv-123", { tranche: 2 })).toBe("split:inv-123:t2");
  });

  it("truncates to 28 bytes when the full string exceeds the limit (ASCII)", () => {
    // "split:" = 6 bytes, so invoiceId can be at most 22 chars before truncation
    const longId = "a".repeat(30); // "split:" + 30 'a's = 36 bytes
    const result = buildPaymentMemo(longId);
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(28);
    expect(result).toBe("split:" + "a".repeat(22));
  });

  it("does not cut in the middle of a multi-byte UTF-8 character", () => {
    // Each '€' is 3 bytes. "split:" = 6 bytes → 22 bytes left.
    // 22 / 3 = 7 full '€' chars = 21 bytes, leaving 1 byte gap (not enough for another '€').
    const euroId = "€".repeat(10); // would be 6 + 30 = 36 bytes untruncated
    const result = buildPaymentMemo(euroId);
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(28);
    // Must be a valid string — no partial multi-byte characters
    expect(result).toBe("split:" + "€".repeat(7)); // 6 + 21 = 27 bytes
    // Confirm we didn't produce an invalid byte sequence
    expect(Buffer.from(result, "utf8").toString("utf8")).toBe(result);
  });

  it("tranche suffix is included when it fits within 28 bytes", () => {
    const result = buildPaymentMemo("short", { tranche: 5 });
    expect(result).toBe("split:short:t5");
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(28);
  });
});

describe("parsePaymentMemo", () => {
  it("parses base format", () => {
    expect(parsePaymentMemo("split:inv-123")).toEqual({ invoiceId: "inv-123" });
  });

  it("parses tranche format", () => {
    expect(parsePaymentMemo("split:inv-123:t2")).toEqual({
      invoiceId: "inv-123",
      tranche: 2,
    });
  });

  it("returns null for a memo without the split: prefix", () => {
    expect(parsePaymentMemo("pay:inv-123")).toBeNull();
    expect(parsePaymentMemo("inv-123")).toBeNull();
    expect(parsePaymentMemo("")).toBeNull();
  });

  it("returns null for an unrelated memo string", () => {
    expect(parsePaymentMemo("some random memo")).toBeNull();
  });
});

describe("round-trip: buildPaymentMemo → parsePaymentMemo", () => {
  it("round-trips base format", () => {
    const id = "inv-abc-999";
    expect(parsePaymentMemo(buildPaymentMemo(id))).toEqual({ invoiceId: id });
  });

  it("round-trips tranche format", () => {
    const id = "inv-abc-999";
    const opts = { tranche: 3 };
    expect(parsePaymentMemo(buildPaymentMemo(id, opts))).toEqual({
      invoiceId: id,
      tranche: opts.tranche,
    });
  });

  it("round-trips correctly even when no truncation occurs", () => {
    // 22 ASCII chars → "split:" + 22 chars = 28 bytes exactly, no truncation
    const id = "a".repeat(22);
    const result = parsePaymentMemo(buildPaymentMemo(id));
    expect(result).toEqual({ invoiceId: id });
  });
});

describe("edge case: truncation affects tranche/invoiceId", () => {
  /**
   * Documented behaviour when truncation hits the tranche suffix:
   *
   * If the full memo is longer than 28 bytes and truncation cuts into or
   * removes the ":t{tranche}" suffix, parsePaymentMemo returns the truncated
   * invoiceId (up to the last ":t" boundary if the boundary itself is cut) and
   * no tranche field.
   *
   * Specifically, if truncation removes the tranche digits entirely but leaves
   * the ":t" separator, the regex won't match ":t" without trailing digits, so
   * it is absorbed into the invoiceId portion.
   */
  it("loses tranche when truncation cuts the tranche digits", () => {
    // invoiceId = "a".repeat(22) → "split:" + 22 'a's = 28 bytes already at the limit.
    // Adding ":t1" would push it to 31 bytes, so it gets truncated back to 28 bytes,
    // dropping the entire ":t1" suffix.
    const id = "a".repeat(22);
    const built = buildPaymentMemo(id, { tranche: 1 });
    expect(Buffer.byteLength(built, "utf8")).toBeLessThanOrEqual(28);
    // The truncated string is just "split:" + 22 'a's — no tranche survives
    const parsed = parsePaymentMemo(built);
    expect(parsed).not.toBeNull();
    expect(parsed?.tranche).toBeUndefined();
  });

  it("returns truncated invoiceId when invoiceId itself is cut", () => {
    // 30 'a's → truncated to 22 'a's after "split:"
    const id = "a".repeat(30);
    const built = buildPaymentMemo(id);
    const parsed = parsePaymentMemo(built);
    expect(parsed).toEqual({ invoiceId: "a".repeat(22) });
  });
});
