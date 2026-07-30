import { describe, it, expect } from "vitest";
import { Memo } from "@stellar/stellar-sdk";
import {
  buildMemo,
  buildHashMemo,
  buildIdMemo,
  parseMemo,
  isStellarSplitMemo,
  MEMO_PREFIX,
} from "../src/memoBuilder.js";
import type { ParsedMemo, SplitConfig } from "../src/types.js";

const CONFIG: SplitConfig = { version: 1 };
const PAYER = "GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCD";
const INVOICE_ID = "42";

describe("buildMemo", () => {
  it("builds a text memo with the canonical SS: prefix", () => {
    const memo = buildMemo(INVOICE_ID, CONFIG, PAYER);
    expect(memo.type).toBe("text");
    const text = memo.value as string;
    expect(text).toMatch(/^SS:v1:42:[A-Z0-9]{8}$/);
  });

  it("fits within the 28-byte text memo limit", () => {
    const memo = buildMemo(INVOICE_ID, CONFIG, PAYER);
    const bytes = new TextEncoder().encode(memo.value as string);
    expect(bytes.length).toBeLessThanOrEqual(28);
  });

  it("includes the payer address suffix", () => {
    const memo = buildMemo(INVOICE_ID, CONFIG, PAYER);
    const text = memo.value as string;
    // Last 8 chars of PAYER
    const expectedSuffix = PAYER.slice(-8);
    expect(text).toContain(expectedSuffix);
  });

  it("encodes the split config version", () => {
    const memo1 = buildMemo(INVOICE_ID, { version: 1 }, PAYER);
    const memo2 = buildMemo(INVOICE_ID, { version: 3 }, PAYER);
    expect((memo1.value as string)).toContain("v1:");
    expect((memo2.value as string)).toContain("v3:");
  });

  it("throws for payer addresses shorter than 8 chars", () => {
    expect(() => buildMemo(INVOICE_ID, CONFIG, "GABC")).toThrow(
      "Payer address must be at least 8 characters",
    );
  });

  it("throws when the memo exceeds 28 bytes", () => {
    // Use a very long invoice ID to force overflow
    const longId = "123456789012345678901234567890";
    expect(() => buildMemo(longId, CONFIG, PAYER)).toThrow(
      "Memo exceeds 28 bytes",
    );
  });
});

describe("buildHashMemo", () => {
  it("returns a hash-type memo", () => {
    const memo = buildHashMemo(INVOICE_ID, CONFIG, PAYER);
    expect(memo.type).toBe("hash");
  });
});

describe("buildIdMemo", () => {
  it("returns an id-type memo for numeric invoice IDs", () => {
    const memo = buildIdMemo("42");
    expect(memo.type).toBe("id");
  });

  it("accepts number input", () => {
    const memo = buildIdMemo(42);
    expect(memo.type).toBe("id");
  });
});

describe("parseMemo", () => {
  it("round-trips: parseMemo(buildMemo(...)) returns original fields", () => {
    const built = buildMemo(INVOICE_ID, CONFIG, PAYER);
    const parsed = parseMemo(built);
    expect(parsed.invoiceId).toBe(INVOICE_ID);
    expect(parsed.version).toBe(CONFIG.version);
    expect(parsed.payerId).toBe(PAYER.slice(-8));
  });

  it("throws for non-text memos", () => {
    const idMemo = buildIdMemo("42");
    expect(() => parseMemo(idMemo)).toThrow(
      'Cannot parse memo of type "id"',
    );
  });

  it("throws for memos without the SS: prefix", () => {
    const memo = Memo.text("random text");
    expect(() => parseMemo(memo)).toThrow(
      `Memo does not start with expected prefix "${MEMO_PREFIX}"`,
    );
  });

  it("throws for memos with invalid version format", () => {
    const memo = Memo.text("SS:abc:42:ABCDEFGH");
    expect(() => parseMemo(memo)).toThrow("Invalid memo format");
  });

  it("throws for memos with empty invoice ID", () => {
    const memo = Memo.text("SS:v1::ABCDEFGH");
    expect(() => parseMemo(memo)).toThrow("empty invoice ID");
  });

  it("throws for memos with wrong payer suffix length", () => {
    const memo = Memo.text("SS:v1:42:ABC");
    expect(() => parseMemo(memo)).toThrow("payer suffix must be 8 characters");
  });
});

describe("isStellarSplitMemo", () => {
  it("returns true for valid split memos", () => {
    const memo = buildMemo(INVOICE_ID, CONFIG, PAYER);
    expect(isStellarSplitMemo(memo)).toBe(true);
  });

  it("returns false for memos without the prefix", () => {
    const memo = Memo.text("hello world");
    expect(isStellarSplitMemo(memo)).toBe(false);
  });

  it("returns false for non-text memos", () => {
    expect(isStellarSplitMemo(Memo.id("1"))).toBe(false);
    expect(isStellarSplitMemo(Memo.none())).toBe(false);
  });
});
