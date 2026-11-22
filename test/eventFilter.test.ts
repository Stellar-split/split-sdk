import { describe, expect, it } from "vitest";

import {
  compileInvoiceEventFilter,
  filterInvoiceEvents,
  InvoiceEventFilterEngine,
} from "../src/eventFilter.js";
import type { InvoiceEvent } from "../src/types.js";

const payment = {
  type: "payment",
  invoiceId: "inv-1",
  ledger: 100,
  timestamp: 1_700_000_000,
  eventId: "event-payment",
  payer: "GAPAYER",
  amount: 100n,
} as InvoiceEvent;

const released = {
  type: "released",
  invoiceId: "inv-2",
  ledger: 101,
  timestamp: 1_700_000_100,
  eventId: "event-release",
  releasedBy: "GARELEASER",
  amount: 100n,
} as InvoiceEvent;

describe("invoice event filters (#1268)", () => {
  it("combines type, entity, range, and nested boolean constraints", () => {
    const filter = compileInvoiceEventFilter({
      types: ["payment", "released"],
      ledger: { min: 100, max: 100 },
      all: [{ invoiceIds: ["inv-1"] }],
      not: { types: ["released"] },
    });

    expect(filter(payment)).toBe(true);
    expect(filter(released)).toBe(false);
  });

  it("filters collections without mutation and records bounded usage stats", () => {
    const events = [payment, released];
    const engine = new InvoiceEventFilterEngine({ any: [{ types: ["payment"] }, { invoiceIds: ["inv-2"] }] });

    expect(filterInvoiceEvents(events, { types: ["payment"] })).toEqual([payment]);
    expect(events).toHaveLength(2);
    expect(engine.filter(events)).toEqual(events);
    expect(engine.getStats()).toEqual({ queries: 1, examined: 2, matched: 2, rejected: 0 });
  });
});
