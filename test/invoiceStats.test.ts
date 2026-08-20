import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  getInvoiceAge,
  getFundingVelocity,
} from "../src/invoiceStats.js";
import type { Invoice } from "../src/types.js";

const SECONDS_PER_DAY = 86_400;

function makeInvoice(
  overrides: Partial<Invoice> & { createdAt: number }
): Invoice {
  return {
    id: "123",
    creator: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
    recipients: [],
    token: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    deadline: 0,
    funded: 0n,
    status: "Pending",
    payments: [],
    ...overrides,
  };
}

/** Set the fake clock to an exact whole-second boundary and return that time. */
function setExactNow(): number {
  const now = Math.floor(Date.now() / 1000) * 1000;
  vi.setSystemTime(now);
  return now;
}

describe("getInvoiceAge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("computes the age of a 2-day-old invoice as 2 days", () => {
    const now = setExactNow();
    const createdAt = now / 1000 - 2 * SECONDS_PER_DAY;

    const age = getInvoiceAge(makeInvoice({ createdAt }));

    expect(age).toEqual({ days: 2, hours: 0, minutes: 0 });
  });

  it("computes the age with hours and minutes remaining", () => {
    const now = setExactNow();
    // 2 days, 3 hours and 45 minutes ago
    const createdAt = now / 1000 - (
      2 * SECONDS_PER_DAY + 3 * 3600 + 45 * 60
    );

    const age = getInvoiceAge(makeInvoice({ createdAt }));

    expect(age).toEqual({ days: 2, hours: 3, minutes: 45 });
  });

  it("accepts createdAt as a millisecond timestamp", () => {
    const now = setExactNow();
    const createdAtMs = now - 3 * SECONDS_PER_DAY * 1000;

    const age = getInvoiceAge(makeInvoice({ createdAt: createdAtMs }));

    expect(age).toEqual({ days: 3, hours: 0, minutes: 0 });
  });

  it("returns zero age for an invoice created just now", () => {
    const now = setExactNow();
    const createdAt = now / 1000;

    const age = getInvoiceAge(makeInvoice({ createdAt }));

    expect(age.days).toBe(0);
    expect(age.hours).toBe(0);
    expect(age.minutes).toBe(0);
  });
});

describe("getFundingVelocity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("computes USDC funded per day for a 2-day-old invoice", () => {
    const now = setExactNow();
    const createdAt = now / 1000 - 2 * SECONDS_PER_DAY;
    // 100_000_000 stroops = 100 USDC over 2 days -> 50/day
    const invoice = makeInvoice({
      createdAt,
      funded: 100_000_000n,
    });

    const velocity = getFundingVelocity(invoice);

    expect(velocity).toBeCloseTo(50_000_000, 5);
  });

  it("returns 0 when the invoice was created in the same second", () => {
    const now = setExactNow();
    const createdAt = now / 1000;

    const velocity = getFundingVelocity(
      makeInvoice({ createdAt, funded: 10_000_000n })
    );

    expect(velocity).toBe(0);
  });

  it("handles millisecond createdAt timestamps identically", () => {
    const now = setExactNow();
    const createdAtMs = now - 4 * SECONDS_PER_DAY * 1000;
    // 200_000_000 stroops = 200 USDC over 4 days -> 50/day
    const invoice = makeInvoice({
      createdAt: createdAtMs,
      funded: 200_000_000n,
    });

    const velocity = getFundingVelocity(invoice);

    expect(velocity).toBeCloseTo(50_000_000, 5);
  });
});