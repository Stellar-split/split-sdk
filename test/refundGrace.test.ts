import { describe, it, expect, vi, afterEach } from "vitest";
import { canRefund, applyPartialRefund } from "../src/refundGrace.js";
import type { Invoice } from "../src/types.js";

const GRACE = 86_400; // 1 day, in seconds

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "1",
    creator: "GCREATOR",
    recipients: [],
    token: "native",
    deadline: 1_000_000,
    funded: 0n,
    status: "Pending",
    payments: [],
    ...overrides,
  } as Invoice;
}

describe("canRefund", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("measures the grace period from invoice.deadline when no reset anchor is given", async () => {
    const invoice = makeInvoice({ deadline: 1_000_000 });
    const status = await canRefund(invoice, { gracePeriodSecs: GRACE });
    expect(status.refundAvailableAt).toBe(1_000_000 + GRACE);
  });

  it("measures the grace period from graceStartedAt when provided", async () => {
    const invoice = makeInvoice({ deadline: 1_000_000 });
    const status = await canRefund(invoice, {
      gracePeriodSecs: GRACE,
      graceStartedAt: 2_000_000,
    });
    expect(status.refundAvailableAt).toBe(2_000_000 + GRACE);
  });

  it("is not refundable before the grace window elapses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime((1_000_000 + 10) * 1000);
    const invoice = makeInvoice({ deadline: 1_000_000 });
    const status = await canRefund(invoice, { gracePeriodSecs: GRACE });
    expect(status.canRefund).toBe(false);
  });
});

describe("applyPartialRefund", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resets the grace period timer to the current timestamp", async () => {
    vi.useFakeTimers();
    const nowSecs = 5_000_000;
    vi.setSystemTime(nowSecs * 1000);

    const invoice = makeInvoice({ deadline: 1_000_000 });
    const result = await applyPartialRefund(invoice, { gracePeriodSecs: GRACE });

    expect(result.graceStartedAt).toBe(nowSecs);
    expect(result.refundAvailableAt).toBe(nowSecs + GRACE);
  });

  it("blocks a full refund requested within the original window after a partial refund", async () => {
    vi.useFakeTimers();

    // Original deadline already passed long ago; without a reset a full refund
    // would be available right now.
    const invoice = makeInvoice({ deadline: 1_000_000 });

    const partialAt = 1_000_050; // 50s after the deadline, inside the original grace window
    vi.setSystemTime(partialAt * 1000);
    const partial = await applyPartialRefund(invoice, { gracePeriodSecs: GRACE });
    expect(partial.canRefund).toBe(false);

    // Still inside the original window, but now also inside the *reset* window.
    vi.setSystemTime((partialAt + 100) * 1000);
    const afterPartial = await canRefund(invoice, {
      gracePeriodSecs: GRACE,
      graceStartedAt: partial.graceStartedAt,
    });
    expect(afterPartial.canRefund).toBe(false);
    expect(afterPartial.refundAvailableAt).toBe(partialAt + GRACE);

    // Once the full reset window elapses, the full refund unlocks.
    vi.setSystemTime((partialAt + GRACE + 1) * 1000);
    const eligible = await canRefund(invoice, {
      gracePeriodSecs: GRACE,
      graceStartedAt: partial.graceStartedAt,
    });
    expect(eligible.canRefund).toBe(true);
  });

  it("does not change the grace period duration, only its start", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000 * 1000);
    const invoice = makeInvoice({ deadline: 1_000_000 });
    const result = await applyPartialRefund(invoice, { gracePeriodSecs: GRACE });
    expect(result.gracePeriodSecs).toBe(GRACE);
  });
});
