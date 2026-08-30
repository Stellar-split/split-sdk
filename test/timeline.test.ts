import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { PaymentTimelineReconstructor } from "../src/timeline/PaymentTimelineReconstructor.js";
import type { ContractEvent } from "../src/events.js";

vi.mock("../src/events.js", () => ({
  replayEvents: vi.fn(),
}));

import { replayEvents } from "../src/events.js";
import type { TimelineEventType, TimelineEntryStatus } from "../src/types/timeline.js";

const mockReplayEvents = replayEvents as ReturnType<typeof vi.fn>;

function sorobanEvent(
  overrides: Partial<ContractEvent> & { type: ContractEvent["type"] },
): ContractEvent {
  return {
    invoiceId: "42",
    ledger: 100,
    timestamp: 1_700_000_000,
    data: {},
    ...overrides,
  };
}

function horizonPayment(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "123",
    ledger: 100,
    created_at: "2024-01-15T00:00:00Z",
    amount: "100.0000000",
    from: "GABC",
    to: "GDEF",
    asset_type: "credit_alphanum4",
    transaction_hash: "tx-horizon-1",
    paging_token: "tok-1",
    memo: "invoice:42",
    type: "payment",
    ...overrides,
  };
}

function makeMockHorizonChain(): {
  operations: ReturnType<typeof vi.fn>;
  call: ReturnType<typeof vi.fn>;
} {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {
    operations: vi.fn(),
    forAccount: vi.fn(),
    limit: vi.fn(),
    cursor: vi.fn(),
    order: vi.fn(),
    call: vi.fn(),
  };

  chain.operations.mockReturnValue(chain);
  chain.forAccount.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  chain.cursor.mockReturnValue(chain);
  chain.order.mockReturnValue(chain);

  return chain as ReturnType<typeof makeMockHorizonChain>;
}

describe("PaymentTimelineReconstructor", () => {
  let reconstructor: PaymentTimelineReconstructor;
  let mockServer: { getEvents: ReturnType<typeof vi.fn> };
  let mockHorizonChain: ReturnType<typeof makeMockHorizonChain>;

  beforeEach(() => {
    mockServer = { getEvents: vi.fn() };
    mockHorizonChain = makeMockHorizonChain();
    mockReplayEvents.mockReset();
    mockHorizonChain.call.mockReset();

    reconstructor = new PaymentTimelineReconstructor({
      rpcUrl: "https://soroban-testnet.stellar.org",
      contractId: "CCONTRACT",
      networkPassphrase: "Test SDF Network ; September 2015",
      server: mockServer as never,
      horizonServer: { operations: mockHorizonChain.operations } as never,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("rebuild", () => {
    it("returns empty timeline when no events or payments exist", async () => {
      mockReplayEvents.mockResolvedValue([]);
      mockHorizonChain.call.mockResolvedValue({ records: [] });

      const result = await reconstructor.rebuild("42");

      expect(result.entries).toEqual([]);
      expect(result.totalEvents).toBe(0);
      expect(result.sources).toEqual({ soroban: 0, horizon: 0 });
      expect(result.deduplicatedCount).toBe(0);
    });

    it("aggregates Soroban events and Horizon payments into sorted timeline", async () => {
      mockReplayEvents.mockResolvedValue([
        sorobanEvent({
          type: "created",
          invoiceId: "42",
          ledger: 100,
          timestamp: 1_700_000_000,
          data: { creator: "GA" },
        }),
        sorobanEvent({
          type: "payment",
          invoiceId: "42",
          ledger: 110,
          timestamp: 1_700_030_000,
          data: { payer: "GB", amount: "50000000" },
        }),
        sorobanEvent({
          type: "released",
          invoiceId: "42",
          ledger: 120,
          timestamp: 1_700_060_000,
          data: { releasedBy: "GC" },
        }),
      ]);

      mockHorizonChain.call.mockResolvedValue({
        records: [
          {
            id: "h1",
            ledger: 105,
            created_at: new Date(1_700_015_000 * 1000).toISOString(),
            amount: "50.0000000",
            from: "GABC",
            to: "GDEF",
            asset_type: "credit_alphanum4",
            transaction_hash: "tx-horizon-1",
            paging_token: "tok-1",
            memo: "invoice:42",
            type: "payment",
          },
          {
            id: "h2",
            ledger: 115,
            created_at: new Date(1_700_045_000 * 1000).toISOString(),
            amount: "50.0000000",
            from: "GXYZ",
            to: "GDEF",
            asset_type: "credit_alphanum4",
            transaction_hash: "tx-horizon-2",
            paging_token: "tok-2",
            memo: "invoice:42",
            type: "payment",
          },
        ],
      });

      const result = await reconstructor.rebuild("42");

      expect(result.entries).toHaveLength(5);
      expect(result.totalEvents).toBe(5);
      expect(result.sources).toEqual({ soroban: 3, horizon: 2 });
      expect(result.deduplicatedCount).toBe(0);

      const ledgerOrder = result.entries.map((e) => e.ledger);
      expect(ledgerOrder).toEqual([100, 105, 110, 115, 120]);

      expect(result.entries[0].type).toBe("invoice_created");
      expect(result.entries[1].type).toBe("payment_received");
      expect(result.entries[1].source).toBe("horizon");
      expect(result.entries[2].type).toBe("payment_received");
      expect(result.entries[2].source).toBe("soroban");
      expect(result.entries[4].type).toBe("status_changed");
    });

    it("deduplicates event present in both Soroban and Horizon", async () => {
      mockReplayEvents.mockResolvedValue([
        sorobanEvent({
          type: "payment",
          invoiceId: "42",
          ledger: 100,
          timestamp: 1_700_000_000,
          data: { txHash: "tx-dup", payer: "GA", amount: "100" },
        }),
      ]);

      mockHorizonChain.call.mockResolvedValue({
        records: [
          horizonPayment({
            ledger: 100,
            transaction_hash: "tx-dup",
            memo: "invoice:42",
          }),
        ],
      });

      const result = await reconstructor.rebuild("42");

      expect(result.entries).toHaveLength(1);
      expect(result.totalEvents).toBe(1);
      expect(result.deduplicatedCount).toBe(1);
      expect(result.sources).toEqual({ soroban: 1, horizon: 1 });
    });

    it("does not deduplicate events with same ledger but different txHash", async () => {
      mockReplayEvents.mockResolvedValue([
        sorobanEvent({
          type: "payment",
          invoiceId: "42",
          ledger: 100,
          timestamp: 1_700_000_000,
          data: { txHash: "tx-soroban", payer: "GA", amount: "100" },
        }),
      ]);

      mockHorizonChain.call.mockResolvedValue({
        records: [
          horizonPayment({
            ledger: 100,
            transaction_hash: "tx-horizon",
            memo: "invoice:42",
          }),
        ],
      });

      const result = await reconstructor.rebuild("42");

      expect(result.entries).toHaveLength(2);
      expect(result.deduplicatedCount).toBe(0);
    });

    it("filters by ledger range (from / to)", async () => {
      mockReplayEvents.mockResolvedValue([
        sorobanEvent({
          type: "created",
          invoiceId: "42",
          ledger: 100,
          timestamp: 1_700_000_000,
        }),
        sorobanEvent({
          type: "payment",
          invoiceId: "42",
          ledger: 200,
          timestamp: 1_700_010_000,
        }),
        sorobanEvent({
          type: "released",
          invoiceId: "42",
          ledger: 300,
          timestamp: 1_700_020_000,
        }),
      ]);

      mockHorizonChain.call.mockResolvedValue({ records: [] });

      const result = await reconstructor.rebuild("42", {
        from: 150,
        to: 250,
      });

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].ledger).toBe(200);
    });

    it("filters by event types", async () => {
      mockReplayEvents.mockResolvedValue([
        sorobanEvent({
          type: "created",
          invoiceId: "42",
          ledger: 100,
          timestamp: 1_700_000_000,
        }),
        sorobanEvent({
          type: "payment",
          invoiceId: "42",
          ledger: 110,
          timestamp: 1_700_010_000,
        }),
        sorobanEvent({
          type: "released",
          invoiceId: "42",
          ledger: 120,
          timestamp: 1_700_020_000,
        }),
      ]);

      mockHorizonChain.call.mockResolvedValue({ records: [] });

      const result = await reconstructor.rebuild("42", {
        types: ["payment_received" as TimelineEventType],
      });

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].type).toBe("payment_received");
    });

    it("maps Soroban event types to TimelineEventType correctly", async () => {
      mockReplayEvents.mockResolvedValue([
        sorobanEvent({ type: "created", invoiceId: "42", ledger: 1, timestamp: 100 }),
        sorobanEvent({ type: "payment", invoiceId: "42", ledger: 2, timestamp: 200 }),
        sorobanEvent({ type: "released", invoiceId: "42", ledger: 3, timestamp: 300 }),
        sorobanEvent({ type: "refunded", invoiceId: "42", ledger: 4, timestamp: 400 }),
        sorobanEvent({ type: "cancelled", invoiceId: "42", ledger: 5, timestamp: 500 }),
        sorobanEvent({ type: "frozen", invoiceId: "42", ledger: 6, timestamp: 600 }),
        sorobanEvent({ type: "unfrozen", invoiceId: "42", ledger: 7, timestamp: 700 }),
      ]);

      mockHorizonChain.call.mockResolvedValue({ records: [] });

      const result = await reconstructor.rebuild("42");

      expect(result.entries).toHaveLength(7);
      expect(result.entries[0].type).toBe("invoice_created");
      expect(result.entries[1].type).toBe("payment_received");
      expect(result.entries.slice(2).every((e) => e.type === "status_changed")).toBe(
        true,
      );
    });

    it("works without Horizon configured", async () => {
      const reconstructorNoHorizon = new PaymentTimelineReconstructor({
        rpcUrl: "https://soroban-testnet.stellar.org",
        contractId: "CCONTRACT",
        networkPassphrase: "Test SDF Network ; September 2015",
        server: mockServer as never,
      });

      mockReplayEvents.mockResolvedValue([
        sorobanEvent({
          type: "created",
          invoiceId: "42",
          ledger: 100,
          timestamp: 1_700_000_000,
        }),
      ]);

      const result = await reconstructorNoHorizon.rebuild("42");

      expect(result.entries).toHaveLength(1);
      expect(result.sources).toEqual({ soroban: 1, horizon: 0 });
    });

    it("returns metadata with correct counts", async () => {
      mockReplayEvents.mockResolvedValue([
        sorobanEvent({
          type: "created",
          invoiceId: "42",
          ledger: 1,
          timestamp: 100,
          data: { txHash: "tx-created" },
        }),
        sorobanEvent({
          type: "payment",
          invoiceId: "42",
          ledger: 2,
          timestamp: 200,
          data: { txHash: "tx-payment" },
        }),
      ]);

      mockHorizonChain.call.mockResolvedValue({
        records: [
          horizonPayment({
            ledger: 2,
            transaction_hash: "tx-payment",
            memo: "invoice:42",
          }),
        ],
      });

      const result = await reconstructor.rebuild("42");

      expect(result.totalEvents).toBe(2);
      expect(result.sources.soroban).toBe(2);
      expect(result.sources.horizon).toBe(1);
      expect(result.deduplicatedCount).toBe(1);
    });

    it("filters events by invoice ID from Soroban stream", async () => {
      mockReplayEvents.mockResolvedValue([
        sorobanEvent({ type: "created", invoiceId: "42", ledger: 1, timestamp: 100 }),
        sorobanEvent({ type: "payment", invoiceId: "99", ledger: 2, timestamp: 200 }),
        sorobanEvent({ type: "released", invoiceId: "42", ledger: 3, timestamp: 300 }),
      ]);

      mockHorizonChain.call.mockResolvedValue({ records: [] });

      const result = await reconstructor.rebuild("42");

      expect(result.entries).toHaveLength(2);
      expect(result.entries[0].ledger).toBe(1);
      expect(result.entries[1].ledger).toBe(3);
    });
  });
});

// ---------------------------------------------------------------------------
// TimelineEntryStatus — status field on TimelineEntry
// ---------------------------------------------------------------------------

describe("TimelineEntryStatus and TimelineEntry.status", () => {
  let reconstructor: PaymentTimelineReconstructor;
  let mockServer: { getEvents: ReturnType<typeof vi.fn> };
  let mockHorizonChain: ReturnType<typeof makeMockHorizonChain>;

  beforeEach(() => {
    mockServer = { getEvents: vi.fn() };
    mockHorizonChain = makeMockHorizonChain();
    mockReplayEvents.mockReset();
    mockHorizonChain.call.mockReset();

    reconstructor = new PaymentTimelineReconstructor({
      rpcUrl: "https://soroban-testnet.stellar.org",
      contractId: "CCONTRACT",
      networkPassphrase: "Test SDF Network ; September 2015",
      server: mockServer as never,
      horizonServer: { operations: mockHorizonChain.operations } as never,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("all Soroban entries carry status: 'completed'", async () => {
    mockReplayEvents.mockResolvedValue([
      sorobanEvent({ type: "created", invoiceId: "42", ledger: 1, timestamp: 100 }),
      sorobanEvent({ type: "payment", invoiceId: "42", ledger: 2, timestamp: 200 }),
    ]);
    mockHorizonChain.call.mockResolvedValue({ records: [] });

    const result = await reconstructor.rebuild("42");
    for (const entry of result.entries) {
      expect(entry.status).toBe("completed" satisfies TimelineEntryStatus);
    }
  });

  it("Horizon payment entries carry status: 'completed'", async () => {
    mockReplayEvents.mockResolvedValue([]);
    mockHorizonChain.call.mockResolvedValue({
      records: [
        horizonPayment({ ledger: 5, transaction_hash: "tx-h1", memo: "invoice:42" }),
      ],
    });

    const result = await reconstructor.rebuild("42");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].status).toBe("completed" satisfies TimelineEntryStatus);
  });

  it("status field is present on every entry regardless of type", async () => {
    mockReplayEvents.mockResolvedValue([
      sorobanEvent({ type: "created",   invoiceId: "42", ledger: 1, timestamp: 100 }),
      sorobanEvent({ type: "payment",   invoiceId: "42", ledger: 2, timestamp: 200 }),
      sorobanEvent({ type: "released",  invoiceId: "42", ledger: 3, timestamp: 300 }),
      sorobanEvent({ type: "refunded",  invoiceId: "42", ledger: 4, timestamp: 400 }),
      sorobanEvent({ type: "cancelled", invoiceId: "42", ledger: 5, timestamp: 500 }),
      sorobanEvent({ type: "frozen",    invoiceId: "42", ledger: 6, timestamp: 600 }),
      sorobanEvent({ type: "unfrozen",  invoiceId: "42", ledger: 7, timestamp: 700 }),
    ]);
    mockHorizonChain.call.mockResolvedValue({ records: [] });

    const result = await reconstructor.rebuild("42");

    expect(result.entries).toHaveLength(7);
    for (const entry of result.entries) {
      expect(entry).toHaveProperty("status");
      expect(["pending", "in_progress", "completed", "failed"]).toContain(entry.status);
    }
  });

  it("TypeScript: TimelineEntryStatus union contains all four values", () => {
    // Compile-time check — these assignments would fail to compile if the
    // union were incomplete.
    const s1: TimelineEntryStatus = "pending";
    const s2: TimelineEntryStatus = "in_progress";
    const s3: TimelineEntryStatus = "completed";
    const s4: TimelineEntryStatus = "failed";
    expect([s1, s2, s3, s4]).toHaveLength(4);
  });
});
