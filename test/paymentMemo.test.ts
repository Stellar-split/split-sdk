import { describe, expect, it } from "vitest";
import { buildPaymentMemo, parsePaymentMemo } from "../src/memoBuilder.js";

describe("buildPaymentMemo / parsePaymentMemo", () => {
  it("builds base format for invoice ID", () => {
    expect(buildPaymentMemo("inv_123")).toBe("split:inv_123");
  });

  it("builds tranche format", () => {
    expect(buildPaymentMemo("inv_123", { tranche: 2 })).toBe("split:inv_123:t2");
  });

  it("truncates to 28 bytes for long invoice IDs", () => {
    const memo = buildPaymentMemo("invoice-very-long-id-1234567890-abcdef");
    expect(Buffer.byteLength(memo, "utf8")).toBeLessThanOrEqual(28);
  });

  it("truncates without cutting a multi-byte UTF-8 character", () => {
    // Multi-byte emoji makes byte length exceed char length
    const memo = buildPaymentMemo("inv-😀😀😀😀😀😀😀😀😀😀-long-id");
    expect(Buffer.byteLength(memo, "utf8")).toBeLessThanOrEqual(28);
    // Last chunk decodes without replacement characters
    const lastChar = memo[memo.length - 1];
    expect(lastChar).not.toBe("\uFFFD");
  });

  it("round-trips base case", () => {
    const memo = buildPaymentMemo("inv_42");
    expect(parsePaymentMemo(memo)).toEqual({ invoiceId: "inv_42" });
  });

  it("round-trips tranche case", () => {
    const memo = buildPaymentMemo("inv_42", { tranche: 3 });
    expect(parsePaymentMemo(memo)).toEqual({ invoiceId: "inv_42", tranche: 3 });
  });

  it("returns null for non-split memo", () => {
    expect(parsePaymentMemo("SS:v1:42:ABCDEFGH")).toBeNull();
    expect(parsePaymentMemo("random-memo")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parsePaymentMemo("")).toBeNull();
  });
});