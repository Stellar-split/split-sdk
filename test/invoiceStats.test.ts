import { describe, it, expect, afterEach, vi } from "vitest";
import {
  getInvoiceAge,
  getFundingVelocity,
  computeInvoiceStats,
} from "../src/invoiceStats.js";
import type { Invoice } from "../src/types.js";

/** Fixed "now" used by every test: 2024-01-11T00:00:00.000Z. */
const NOW_MS = 1_704_931_200_000;
const NOW_SECONDS = NOW_MS / 1000;

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "1",
    creator: "GCREATOR",
    recipients: [{ address: "GRECIPIENT", amount: 1_000n }],
    token: "TOKEN_USDC",
    deadline: 2_000_000_000,
    funded: 0n,
    status: "Pending",
    payments: [],
    ...overrides,
  };
}

/** Pin `Date.now()` so age-based maths is deterministic. */
function freezeNow(nowMs: number = NOW_MS): void {
  vi.useFakeTimers();
  vi.setSystemTime(nowMs);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("getInvoiceAge", () => {
  it("reports 2 days for an invoice created exactly 2 days ago", () => {
    freezeNow();
    const invoice = makeInvoice({ createdAt: NOW_SECONDS - 2 * 86_400 });

    expect(getInvoiceAge(invoice)).toEqual({ days: 2, hours: 0, minutes: 0 });
  });

  it("breaks the age down into days, remainder hours, and remainder minutes", () => {
    freezeNow();
    const createdMs = NOW_MS - (3 * MS_PER_DAY + 5 * MS_PER_HOUR + 47 * MS_PER_MINUTE);
    const invoice = makeInvoice({ createdAt: createdMs });

    expect(getInvoiceAge(invoice)).toEqual({ days: 3, hours: 5, minutes: 47 });
  });

  it("truncates sub-minute remainders instead of rounding up", () => {
    freezeNow();
    const invoice = makeInvoice({ createdAt: NOW_MS - (59 * 1000 + 999) });

    expect(getInvoiceAge(invoice)).toEqual({ days: 0, hours: 0, minutes: 0 });
  });

  it("returns a zero age for an invoice created right now", () => {
    freezeNow();
    const invoice = makeInvoice({ createdAt: NOW_MS });

    expect(getInvoiceAge(invoice)).toEqual({ days: 0, hours: 0, minutes: 0 });
  });

  it("clamps a future createdAt to a zero age", () => {
    freezeNow();
    const invoice = makeInvoice({ createdAt: NOW_SECONDS + 86_400 });

    expect(getInvoiceAge(invoice)).toEqual({ days: 0, hours: 0, minutes: 0 });
  });

  it("returns a zero age when createdAt is absent", () => {
    freezeNow();

    expect(getInvoiceAge(makeInvoice())).toEqual({
      days: 0,
      hours: 0,
      minutes: 0,
    });
  });

  it("treats createdAt: 0 as unknown rather than epoch 1970", () => {
    freezeNow();

    // Read as a real timestamp this would report a ~20,000-day age.
    expect(getInvoiceAge(makeInvoice({ createdAt: 0 }))).toEqual({
      days: 0,
      hours: 0,
      minutes: 0,
    });
  });

  it("treats negative and non-finite createdAt values as unknown", () => {
    freezeNow();

    for (const createdAt of [-1, -NOW_SECONDS, Number.NaN, Infinity, -Infinity]) {
      expect(getInvoiceAge(makeInvoice({ createdAt }))).toEqual({
        days: 0,
        hours: 0,
        minutes: 0,
      });
    }
  });

  it("uses Date.now() internally, so the age grows as time passes", () => {
    freezeNow();
    const invoice = makeInvoice({ createdAt: NOW_MS });

    expect(getInvoiceAge(invoice).days).toBe(0);

    vi.setSystemTime(NOW_MS + 2 * MS_PER_DAY + 3 * MS_PER_HOUR);

    expect(getInvoiceAge(invoice)).toEqual({ days: 2, hours: 3, minutes: 0 });
  });
});

describe("getInvoiceAge — timestamp format auto-detection", () => {
  it("treats values above 1e12 as milliseconds and below as seconds", () => {
    freezeNow();
    const twoDays = 2 * 86_400;

    const seconds = makeInvoice({ createdAt: NOW_SECONDS - twoDays });
    const millis = makeInvoice({ createdAt: NOW_MS - twoDays * 1000 });

    expect(getInvoiceAge(seconds)).toEqual(getInvoiceAge(millis));
    expect(getInvoiceAge(seconds).days).toBe(2);
  });

  it("does not mistake a seconds timestamp for milliseconds", () => {
    freezeNow();
    // 1_704_844_800 s = 1 day before NOW; read as ms it would be ~1970.
    const invoice = makeInvoice({ createdAt: 1_704_844_800 });

    expect(getInvoiceAge(invoice)).toEqual({ days: 1, hours: 0, minutes: 0 });
  });
});

describe("getFundingVelocity", () => {
  it("returns funded units per day for a known funded/age ratio", () => {
    freezeNow();
    // 500 funded over 4 days => 125 per day.
    const invoice = makeInvoice({
      funded: 500n,
      createdAt: NOW_SECONDS - 4 * 86_400,
    });

    expect(getFundingVelocity(invoice)).toBeCloseTo(125, 10);
  });

  it("scales linearly with the funded amount", () => {
    freezeNow();
    const createdAt = NOW_SECONDS - 86_400 / 2; // half a day old

    expect(
      getFundingVelocity(makeInvoice({ funded: 100n, createdAt }))
    ).toBeCloseTo(200, 10);
    expect(
      getFundingVelocity(makeInvoice({ funded: 250n, createdAt }))
    ).toBeCloseTo(500, 10);
  });

  it("handles large bigint funded amounts without overflowing", () => {
    freezeNow();
    const invoice = makeInvoice({
      funded: 10_000_000_000n, // 1_000 USDC in stroops
      createdAt: NOW_SECONDS - 10 * 86_400,
    });

    expect(getFundingVelocity(invoice)).toBeCloseTo(1_000_000_000, 0);
  });

  it("returns 0 when createdAt is within the same second as now", () => {
    freezeNow();

    expect(getFundingVelocity(makeInvoice({ funded: 500n, createdAt: NOW_MS }))).toBe(0);
    expect(
      getFundingVelocity(makeInvoice({ funded: 500n, createdAt: NOW_MS - 999 }))
    ).toBe(0);
    expect(
      getFundingVelocity(makeInvoice({ funded: 500n, createdAt: NOW_SECONDS }))
    ).toBe(0);
  });

  it("returns 0 for a future createdAt", () => {
    freezeNow();
    const invoice = makeInvoice({
      funded: 500n,
      createdAt: NOW_SECONDS + 3_600,
    });

    expect(getFundingVelocity(invoice)).toBe(0);
  });

  it("returns 0 when createdAt is absent", () => {
    freezeNow();

    expect(getFundingVelocity(makeInvoice({ funded: 500n }))).toBe(0);
  });

  it("returns 0 for the createdAt: 0 sentinel instead of a bogus rate", () => {
    freezeNow();

    expect(getFundingVelocity(makeInvoice({ funded: 500n, createdAt: 0 }))).toBe(0);
  });

  it("returns 0 for negative and non-finite createdAt values", () => {
    freezeNow();

    for (const createdAt of [-1, -NOW_SECONDS, Number.NaN, Infinity, -Infinity]) {
      expect(getFundingVelocity(makeInvoice({ funded: 500n, createdAt }))).toBe(0);
    }
  });

  it("returns 0 for an unfunded invoice", () => {
    freezeNow();
    const invoice = makeInvoice({
      funded: 0n,
      createdAt: NOW_SECONDS - 7 * 86_400,
    });

    expect(getFundingVelocity(invoice)).toBe(0);
  });

  it("detects seconds and milliseconds createdAt formats identically", () => {
    freezeNow();
    const twoDays = 2 * 86_400;

    const seconds = makeInvoice({
      funded: 1_000n,
      createdAt: NOW_SECONDS - twoDays,
    });
    const millis = makeInvoice({
      funded: 1_000n,
      createdAt: NOW_MS - twoDays * 1000,
    });

    expect(getFundingVelocity(seconds)).toBeCloseTo(500, 10);
    expect(getFundingVelocity(millis)).toBeCloseTo(
      getFundingVelocity(seconds),
      10
    );
  });
});

describe("computeInvoiceStats — unchanged by the new helpers", () => {
  it("still derives aggregate stats from the payment history", () => {
    const invoice = makeInvoice({
      funded: 1_000n,
      status: "Released",
      recipients: [{ address: "R1", amount: 1_000n }],
      payments: [
        { payer: "P1", amount: 400n, timestamp: 1_000 },
        { payer: "P2", amount: 600n, timestamp: 1_000 + 86_400 },
      ],
    });

    const stats = computeInvoiceStats(invoice);

    expect(stats.totalPayers).toBe(2);
    expect(stats.avgPayment).toBe(500n);
    expect(stats.fundingVelocity).toBeCloseTo(1_000, 10);
    expect(stats.timeToCompletion).toBe(86_400);
    expect(stats.completionBps).toBe(10_000);
  });
});
