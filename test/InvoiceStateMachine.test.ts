import { describe, it, expect, vi } from "vitest";
import { InvoiceStateMachine } from "../src/state/InvoiceStateMachine.js";
import { InvalidTransitionError } from "../src/types.js";
import type { Invoice, InvoiceStatus } from "../src/types.js";

const ALL_STATUSES: InvoiceStatus[] = ["Pending", "Released", "Refunded", "Cancelled"];

function makeInvoice(status: InvoiceStatus, overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "inv-1",
    creator: "GCREATOR",
    recipients: [],
    token: "GTOKEN",
    deadline: 0,
    funded: 0n,
    status,
    payments: [],
    ...overrides,
  };
}

const VALID_PAIRS: Array<[InvoiceStatus, InvoiceStatus]> = [
  ["Pending", "Released"],
  ["Pending", "Refunded"],
  ["Pending", "Cancelled"],
];

const ALL_PAIRS: Array<[InvoiceStatus, InvoiceStatus]> = ALL_STATUSES.flatMap((from) =>
  ALL_STATUSES.map((to): [InvoiceStatus, InvoiceStatus] => [from, to]),
).filter(([from, to]) => from !== to);

const INVALID_PAIRS = ALL_PAIRS.filter(
  ([from, to]) => !VALID_PAIRS.some(([vf, vt]) => vf === from && vt === to),
);

describe("InvoiceStateMachine — full transition matrix", () => {
  it.each(VALID_PAIRS)("allows %s -> %s", (from, to) => {
    const sm = new InvoiceStateMachine();
    expect(sm.validate(from, to)).toBe(true);

    const invoice = makeInvoice(from);
    const updated = sm.transition(invoice, to);
    expect(updated.status).toBe(to);
    expect(updated.statusHistory).toHaveLength(1);
    expect(updated.statusHistory![0]).toMatchObject({ from, to });
    expect(typeof updated.statusHistory![0]!.at).toBe("number");
  });

  it.each(INVALID_PAIRS)("rejects %s -> %s", (from, to) => {
    const sm = new InvoiceStateMachine();
    expect(() => sm.validate(from, to)).toThrow(InvalidTransitionError);

    const invoice = makeInvoice(from);
    try {
      sm.transition(invoice, to);
      expect.unreachable("transition() should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransitionError);
      const e = err as InvalidTransitionError;
      expect(e.from).toBe(from);
      expect(e.to).toBe(to);
      expect(e.allowed).toEqual(sm.allowedFrom(from));
    }
  });

  it("covers exactly the 3 valid and 9 invalid ordered pairs among the 4 statuses", () => {
    expect(VALID_PAIRS).toHaveLength(3);
    expect(INVALID_PAIRS).toHaveLength(9);
    expect(VALID_PAIRS.length + INVALID_PAIRS.length).toBe(ALL_PAIRS.length);
  });
});

describe("InvoiceStateMachine — transition()", () => {
  it("does not mutate the input invoice or its statusHistory array", () => {
    const sm = new InvoiceStateMachine();
    const original = makeInvoice("Pending", { statusHistory: [] });
    const originalHistoryRef = original.statusHistory;

    const updated = sm.transition(original, "Released");

    expect(original.status).toBe("Pending");
    expect(original.statusHistory).toBe(originalHistoryRef);
    expect(original.statusHistory).toHaveLength(0);
    expect(updated).not.toBe(original);
    expect(updated.statusHistory).not.toBe(originalHistoryRef);
    expect(updated.statusHistory).toHaveLength(1);
  });

  it("appends to existing statusHistory rather than replacing it", () => {
    const sm = new InvoiceStateMachine();
    const invoice = makeInvoice("Pending", {
      statusHistory: [{ from: "Pending", to: "Pending", at: 0 }],
    });
    const updated = sm.transition(invoice, "Cancelled");
    expect(updated.statusHistory).toHaveLength(2);
  });

  it("fires on('transition') with correct before/after snapshots after a successful transition", () => {
    const sm = new InvoiceStateMachine();
    const handler = vi.fn();
    sm.on("transition", handler);

    const invoice = makeInvoice("Pending");
    const updated = sm.transition(invoice, "Refunded");

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0]![0];
    expect(event.invoiceId).toBe("inv-1");
    expect(event.from).toBe("Pending");
    expect(event.to).toBe("Refunded");
    expect(event.before).toBe(invoice);
    expect(event.after).toBe(updated);
  });

  it("fires on('invalidTransition') with { invoiceId, from, to, allowed } and does not fire on('transition')", () => {
    const sm = new InvoiceStateMachine();
    const transitionHandler = vi.fn();
    const invalidHandler = vi.fn();
    sm.on("transition", transitionHandler);
    sm.on("invalidTransition", invalidHandler);

    const invoice = makeInvoice("Released");
    expect(() => sm.transition(invoice, "Pending")).toThrow(InvalidTransitionError);

    expect(transitionHandler).not.toHaveBeenCalled();
    expect(invalidHandler).toHaveBeenCalledTimes(1);
    expect(invalidHandler).toHaveBeenCalledWith({
      invoiceId: "inv-1",
      from: "Released",
      to: "Pending",
      allowed: [],
    });
  });
});

describe("InvoiceStateMachine — custom StateMachineConfig", () => {
  it("overrides the default graph while keeping validation logic intact", () => {
    const sm = new InvoiceStateMachine({
      transitions: {
        Pending: ["Cancelled"],
        Cancelled: ["Pending"],
      },
    });

    expect(sm.validate("Pending", "Cancelled")).toBe(true);
    expect(sm.validate("Cancelled", "Pending")).toBe(true);
    expect(() => sm.validate("Pending", "Released")).toThrow(InvalidTransitionError);
    expect(() => sm.validate("Pending", "Refunded")).toThrow(InvalidTransitionError);

    const invoice = makeInvoice("Cancelled");
    const updated = sm.transition(invoice, "Pending");
    expect(updated.status).toBe("Pending");
  });

  it("treats statuses omitted from a custom graph as terminal", () => {
    const sm = new InvoiceStateMachine({ transitions: { Pending: ["Released"] } });
    expect(sm.allowedFrom("Released")).toEqual([]);
    expect(() => sm.validate("Released", "Pending")).toThrow(InvalidTransitionError);
  });
});
