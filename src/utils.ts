/**
 * Utility helpers for StellarSplit SDK.
 */
import { Invoice } from "./types";
import { Account, MuxedAccount, StrKey } from "@stellar/stellar-sdk";
import { StellarSplitError } from "./errors.js";
import { describe, it, expect } from "vitest";

/** Number of decimal places used by Stellar token amounts (stroops). */
const STROOPS_PER_UNIT = 10_000_000n;

/**
 * Format a stroop amount as a fixed 7-decimal string.
 *
 * The integer part is `stroops / 10_000_000` and the fractional part is the
 * remainder, left-padded to 7 digits. No thousands separators or currency
 * symbol are added; the value is intended for display next to an asset code
 * such as "USDC". Designed for non-negative amounts.
 *
 * @param stroops - Raw on-chain amount in stroops (1 unit = 10,000,000 stroops).
 * @returns The amount as a `"<whole>.<7-digit fraction>"` string.
 *
 * @example
 * formatAmount(10_000_000n); // "1.0000000"
 * formatAmount(15_500_000n); // "1.5500000"
 * formatAmount(7n);          // "0.0000007"
 */
export function formatAmount(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_UNIT;
  const frac = stroops % STROOPS_PER_UNIT;
  return `${whole}.${frac.toString().padStart(7, "0")}`;
}

/**
 * Parse a human-readable decimal amount into stroops.
 *
 * Splits `value` on the first `.`; a missing whole part defaults to `"0"` and a
 * missing fractional part to `""`. The fractional part is right-padded with
 * zeros and truncated to 7 digits (extra precision is dropped, not rounded).
 *
 * @param value - Decimal string such as `"1.5"`, `"0.25"`, or `"10"`.
 * @returns The equivalent amount in stroops.
 * @throws {SyntaxError} If the whole or fractional part is not a valid integer
 *   (for example `parseAmount("abc")` or `parseAmount("1.2x")`).
 *
 * @example
 * parseAmount("1.5");       // 15_000_000n
 * parseAmount("2");         // 20_000_000n
 * parseAmount("0.00000015"); // 1n  (8th decimal is truncated)
 */
export function parseAmount(value: string): bigint {
  if (typeof value !== "string") {
    throw new SyntaxError(`Invalid amount: expected a string, got ${typeof value}`);
  }
  const isNegative = value.startsWith("-");
  const clean = isNegative ? value.slice(1) : value;
  const parts = clean.split(".");
  if (parts.length > 2) {
    throw new SyntaxError(`Invalid amount "${value}": multiple decimal points`);
  }
  const [whole = "0", frac = ""] = parts;
  if (!/^[+]?\d*$/.test(whole)) {
    throw new SyntaxError(`Invalid whole part "${whole}"`);
  }
  if (!/^\d*$/.test(frac)) {
    throw new SyntaxError(`Invalid fractional part "${frac}"`);
  }
  const fracPadded = frac.padEnd(7, "0").slice(0, 7);
  const wholePart = whole === "" || whole === "+" ? 0n : BigInt(whole);
  const fracPart = fracPadded === "" ? 0n : BigInt(fracPadded);
  const total = wholePart * STROOPS_PER_UNIT + fracPart;
  return isNegative ? -total : total;
}

export function groupBy<T extends Record<string, any>>(
  array: T[],
  key: keyof T,
): Record<string, T[]> {
  return array.reduce<Record<string, T[]>>((groups, item) => {
    const groupKey = String(item[key]);
    groups[groupKey] ??= [];
    groups[groupKey].push(item);
    return groups;
  }, {});
}

/**
 * Report whether `address` is a valid Stellar ed25519 public key (`G...`).
 *
 * Delegates to stellar-sdk `StrKey.isValidEd25519PublicKey`, which checks the
 * version byte, length, and CRC16 checksum. Muxed (`M...`) and secret (`S...`)
 * keys return `false`.
 *
 * @param address - Candidate address string.
 * @returns `true` if `address` is a well-formed `G...` public key.
 *
 * @example
 * isValidStellarAddress("GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ"); // true
 * isValidStellarAddress("GABC"); // false
 * isValidStellarAddress("");     // false
 */
export function isValidStellarAddress(address: string): boolean {
  return StrKey.isValidEd25519PublicKey(address);
}

/**
 * Compare two address strings for equality, ignoring case.
 *
 * This is a plain string comparison after lower-casing both operands; it does
 * not decode or validate either address and does not treat a muxed address as
 * equal to its underlying `G...` account.
 *
 * @param a - First address.
 * @param b - Second address.
 * @returns `true` if the two strings are equal when lower-cased.
 *
 * @example
 * addressesEqual("GABC", "gabc"); // true
 * addressesEqual("GABC", "GXYZ"); // false
 */
export function addressesEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Build a muxed (`M...`) address from a base account and a subaccount id.
 *
 * @param address - Base Stellar public key (`G...`).
 * @param id - Muxed subaccount id (0 to 2^64 - 1).
 * @returns The muxed account id string (`M...`).
 * @throws {Error} If `address` is not a valid `G...` public key or `id` is out
 *   of the unsigned 64-bit range (thrown by the stellar-sdk `Account` /
 *   `MuxedAccount` constructors).
 *
 * @example
 * const m = toMuxedAddress(
 *   "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ",
 *   42n,
 * );
 * // m is the corresponding muxed id, e.g. "MA7QYNF7SOWQ3GLR2BGM...UAAAAAAAAAAAAF6VW"
 */
export function toMuxedAddress(address: string, id: bigint): string {
  const account = new Account(address, "0");
  const muxed = new MuxedAccount(account, id.toString());
  return muxed.accountId();
}

/**
 * Split a muxed (`M...`) address back into its base account and subaccount id.
 *
 * Inverse of {@link toMuxedAddress}.
 *
 * @param muxed - Muxed account id string (`M...`).
 * @returns An object with the base `G...` `address` and the numeric `id`.
 * @throws {Error} If `muxed` is not a valid `M...` address (thrown by
 *   stellar-sdk `MuxedAccount.fromAddress`).
 *
 * @example
 * const { address, id } = fromMuxedAddress(toMuxedAddress(
 *   "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ",
 *   42n,
 * ));
 * // address === "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ", id === 42n
 */
export function fromMuxedAddress(muxed: string): { address: string; id: bigint } {
  const parsed = MuxedAccount.fromAddress(muxed, "0");
  return {
    address: parsed.baseAccount().accountId(),
    id: BigInt(parsed.id()),
  };
}

/**
 * Compute a Unix timestamp (seconds) `days` days from now.
 *
 * Uses `Date.now()` at call time. `days` may be fractional or negative; the
 * result is floored to a whole second.
 *
 * @param days - Number of days from now (1 day = 86,400 seconds).
 * @returns A Unix timestamp in seconds.
 *
 * @example
 * deadlineFromDays(7); // now (in seconds) + 604800
 */
export function deadlineFromDays(days: number): number {
  return Math.floor(Date.now() / 1000) + days * 86_400;
}

/**
 * Report whether a Unix timestamp deadline lies strictly in the past.
 *
 * Compares `deadline` against the current time floored to whole seconds; a
 * deadline exactly equal to the current second is not yet expired.
 *
 * @param deadline - Unix timestamp in seconds.
 * @returns `true` if the current time is past `deadline`.
 *
 * @example
 * isExpired(Math.floor(Date.now() / 1000) - 60); // true
 * isExpired(Math.floor(Date.now() / 1000) + 60); // false
 */
export function isExpired(deadline: number): boolean {
  return Math.floor(Date.now() / 1000) > deadline;
}

/**
 * Shorten an address for display as `"<head>...<tail>"`.
 *
 * Returns `address` unchanged when it is short enough that truncation would not
 * save space (length at most `chars * 2 + 3`).
 *
 * @param address - Address (or any string) to shorten.
 * @param chars - Number of leading and trailing characters to keep. Defaults to 4.
 * @returns The truncated string, or the original when it is already short.
 *
 * @example
 * truncateAddress("GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ");    // "GA7Q...VSGZ"
 * truncateAddress("GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ", 6); // "GA7QYN...UJVSGZ"
 * truncateAddress("GABCDEF"); // "GABCDEF" (too short to truncate)
 */
export function truncateAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

/**
 * Shorten an address for display with configurable head and tail lengths.
 *
 * Unlike {@link truncateAddress}, this always truncates and throws rather than
 * returning a short input unchanged.
 *
 * @param address - Address to format.
 * @param opts - Optional lengths.
 * @param opts.leading - Leading characters to keep. Defaults to 5.
 * @param opts.trailing - Trailing characters to keep. Defaults to 4.
 * @returns The formatted `"<leading>...<trailing>"` string.
 * @throws {StellarSplitError} With code `INVALID_RECIPIENT` if `address` is
 *   shorter than `leading + trailing + 3`.
 *
 * @example
 * formatAddress("GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ");
 * // "GA7QY...VSGZ"
 * formatAddress("GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ", {
 *   leading: 8,
 *   trailing: 6,
 * });
 * // "GA7QYNF7...UJVSGZ"
 *
 * @example
 * // Throws StellarSplitError { code: "INVALID_RECIPIENT" }
 * formatAddress("GABC");
 */
export function formatAddress(
  address: string,
  opts?: { leading?: number; trailing?: number }
): string {
  const leading = opts?.leading ?? 5;
  const trailing = opts?.trailing ?? 4;
  if (address.length < leading + trailing + 3) {
    throw new StellarSplitError(
      `Address too short to format: ${address}`,
      "INVALID_RECIPIENT",
      { address, leading, trailing }
    );
  }
  return `${address.slice(0, leading)}...${address.slice(-trailing)}`;
}

/**
 * Check whether a caller is permitted to act on an invoice.
 *
 * When `invoice.allowed_callers` is `undefined` or `null` the invoice is open
 * and every caller is allowed. Otherwise the caller must appear in the list
 * (exact, case-sensitive string match).
 *
 * @param invoice - Invoice whose `allowed_callers` list is consulted.
 * @param callerAddress - Address requesting to act on the invoice.
 * @returns `{ allowed: true }` when permitted, otherwise
 *   `{ allowed: false, reason: "caller not in allowlist" }`.
 *
 * @example
 * validateCallerAllowlist({ ...invoice, allowed_callers: null }, "GABC");
 * // { allowed: true }
 *
 * validateCallerAllowlist(
 *   { ...invoice, allowed_callers: ["GXYZ"] },
 *   "GABC",
 * );
 * // { allowed: false, reason: "caller not in allowlist" }
 */
export function validateCallerAllowlist(
  invoice: Invoice,
  callerAddress: string
): { allowed: boolean; reason?: string } {
  if (!invoice.allowed_callers) {
    return { allowed: true };
  }
  if (invoice.allowed_callers.includes(callerAddress)) {
    return { allowed: true };
  }
  return { allowed: false, reason: "caller not in allowlist" };
}

/**
 * Compute the late-payment penalty owed for an invoice at a given payment time.
 *
 * Returns a zero penalty (`penaltyBps: 0`, `penaltyAmount: 0n`, `tier: null`)
 * when any of the following hold:
 * - `invoice.penalty_deadline` is not set, or the payment is on or before it;
 * - `invoice.penalty_tiers` is missing or empty;
 * - no configured tier applies to the number of days late.
 *
 * Otherwise days late is `ceil((paymentTimestamp - penalty_deadline) / 86400)`,
 * and the highest tier whose `days_late` threshold is met is selected. The
 * penalty amount is `sum(recipient.amount) * tier.penalty_bps / 10_000`
 * (integer bigint division). `tier` is the index of the applied tier within the
 * original `invoice.penalty_tiers` array.
 *
 * @param invoice - Invoice carrying `penalty_deadline`, `penalty_tiers`, and
 *   `recipients`.
 * @param paymentTimestamp - Unix timestamp (seconds) the payment is made.
 * @returns The penalty in basis points, the penalty amount in stroops, and the
 *   index of the applied tier (or `null` when no penalty applies).
 *
 * @example
 * const invoice = {
 *   penalty_deadline: 1_000_000,
 *   penalty_tiers: [
 *     { days_late: 1, penalty_bps: 100 },
 *     { days_late: 7, penalty_bps: 500 },
 *   ],
 *   recipients: [{ address: "GABC", amount: 100_000_000n }],
 * } as Invoice;
 *
 * calculatePenalty(invoice, 1_000_000 + 3 * 86_400);
 * // { penaltyBps: 100, penaltyAmount: 1_000_000n, tier: 0 }
 *
 * calculatePenalty(invoice, 1_000_000); // on time
 * // { penaltyBps: 0, penaltyAmount: 0n, tier: null }
 */
export function calculatePenalty(
  invoice: Invoice,
  paymentTimestamp: number
): { penaltyBps: number; penaltyAmount: bigint; tier: number | null } {
  if (!invoice.penalty_deadline || paymentTimestamp <= invoice.penalty_deadline) {
    return { penaltyBps: 0, penaltyAmount: 0n, tier: null };
  }

  if (!invoice.penalty_tiers || invoice.penalty_tiers.length === 0) {
    return { penaltyBps: 0, penaltyAmount: 0n, tier: null };
  }

  const daysLate = Math.ceil((paymentTimestamp - invoice.penalty_deadline) / 86400);

  // Sort tiers by days_late descending to find the highest applicable tier
  const sortedTiers = [...invoice.penalty_tiers].sort((a, b) => b.days_late - a.days_late);
  const applicableTier = sortedTiers.find(tier => daysLate >= tier.days_late);

  if (!applicableTier) {
    return { penaltyBps: 0, penaltyAmount: 0n, tier: null };
  }

  const totalAmount = invoice.recipients.reduce((sum, r) => sum + r.amount, 0n);
  const penaltyAmount = (totalAmount * BigInt(applicableTier.penalty_bps)) / 10000n;

  return {
    penaltyBps: applicableTier.penalty_bps,
    penaltyAmount,
    tier: invoice.penalty_tiers.indexOf(applicableTier)
  };
}

/** Maximum value representable by a signed 64-bit integer (INT64_MAX). */
const INT64_MAX = 9_223_372_036_854_775_807n;

describe("parseAmount", () => {
  describe("zero amounts", () => {
    it("parses \"0\" as zero stroops", () => {
      expect(parseAmount("0")).toBe(0n);
    });

    it("parses \"0.0\" as zero stroops", () => {
      expect(parseAmount("0.0")).toBe(0n);
    });

    it("parses \"0.0000000\" as zero stroops", () => {
      expect(parseAmount("0.0000000")).toBe(0n);
    });

    it("parses \"-0\" as zero stroops", () => {
      expect(parseAmount("-0")).toBe(0n);
    });

    it("parses \".0\" as zero stroops", () => {
      expect(parseAmount(".0")).toBe(0n);
    });

    it("parses \"0.\" as zero stroops", () => {
      expect(parseAmount("0.")).toBe(0n);
    });
  });

  describe("maximum amounts", () => {
    it("parses INT64_MAX stroops exactly", () => {
      // 922337203685.4775807 units
      expect(parseAmount("922337203685.4775807")).toBe(INT64_MAX);
    });

    it("parses INT64_MAX + 1 stroops without overflow", () => {
      expect(parseAmount("922337203685.4775808")).toBe(INT64_MAX + 1n);
    });

    it("parses a very large whole part", () => {
      expect(parseAmount("1000000000000")).toBe(10_000_000_000_000_000_000n);
    });
  });

  describe("decimal handling", () => {
    it("parses whole numbers", () => {
      expect(parseAmount("1")).toBe(10_000_000n);
      expect(parseAmount("2")).toBe(20_000_000n);
    });

    it("parses one decimal place", () => {
      expect(parseAmount("1.5")).toBe(15_000_000n);
    });

    it("parses two decimal places", () => {
      expect(parseAmount("0.25")).toBe(2_500_000n);
    });

    it("parses exactly 7 decimal places", () => {
      expect(parseAmount("1.2345678")).toBe(12_345_678n);
    });

    it("truncates an 8th decimal place (no rounding)", () => {
      expect(parseAmount("0.00000015")).toBe(1n);
      expect(parseAmount("0.00000019")).toBe(1n);
    });

    it("truncates extra precision beyond 7 decimals", () => {
      expect(parseAmount("1.123456789")).toBe(11_234_567n);
    });

    it("pads trailing zeros in the fractional part", () => {
      expect(parseAmount("1.5")).toBe(parseAmount("1.5000000"));
      expect(parseAmount("0.1")).toBe(1_000_000n);
    });

    it("parses a leading-dot amount", () => {
      expect(parseAmount(".5")).toBe(5_000_000n);
    });

    it("parses a trailing-dot amount", () => {
      expect(parseAmount("5.")).toBe(50_000_000n);
    });

    it("parses a leading plus sign", () => {
      expect(parseAmount("+1.5")).toBe(15_000_000n);
    });

    it("parses negative amounts", () => {
      expect(parseAmount("-1.5")).toBe(-15_000_000n);
      expect(parseAmount("-0.0000001")).toBe(-1n);
    });
  });

  describe("invalid inputs", () => {
    it("rejects NaN", () => {
      expect(() => parseAmount("NaN")).toThrow(SyntaxError);
    });

    it("rejects Infinity", () => {
      expect(() => parseAmount("Infinity")).toThrow(SyntaxError);
      expect(() => parseAmount("-Infinity")).toThrow(SyntaxError);
    });

    it("rejects scientific notation", () => {
      expect(() => parseAmount("1e7")).toThrow(SyntaxError);
      expect(() => parseAmount("1.5e3")).toThrow(SyntaxError);
    });

    it("rejects non-numeric strings", () => {
      expect(() => parseAmount("abc")).toThrow(SyntaxError);
      expect(() => parseAmount("")).not.toThrow();
    });

    it("rejects malformed fractional parts", () => {
      expect(() => parseAmount("1.2x")).toThrow(SyntaxError);
      expect(() => parseAmount("1.-2")).toThrow(SyntaxError);
    });

    it("rejects multiple decimal points", () => {
      expect(() => parseAmount("1.2.3")).toThrow(SyntaxError);
    });

    it("rejects whitespace and separators", () => {
      expect(() => parseAmount(" 1")).toThrow(SyntaxError);
      expect(() => parseAmount("1,000")).toThrow(SyntaxError);
    });

    it("rejects unsupported types", () => {
      expect(() => parseAmount(1 as unknown as string)).toThrow(SyntaxError);
      expect(() => parseAmount(null as unknown as string)).toThrow(SyntaxError);
      expect(() => parseAmount(undefined as unknown as string)).toThrow(SyntaxError);
    });
  });

  describe("boundary values", () => {
    it("parses the smallest positive amount (1 stroop)", () => {
      expect(parseAmount("0.0000001")).toBe(1n);
    });

    it("parses the largest 7-decimal fraction", () => {
      expect(parseAmount("0.9999999")).toBe(9_999_999n);
    });

    it("carries over when fraction is all nines", () => {
      expect(parseAmount("1.9999999")).toBe(19_999_999n);
    });

    it("round-trips with formatAmount", () => {
      expect(formatAmount(parseAmount("1.5500000"))).toBe("1.5500000");
      expect(formatAmount(parseAmount("0.0000007"))).toBe("0.0000007");
    });
  });
});
