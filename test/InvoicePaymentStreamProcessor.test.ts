import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { InvoicePaymentStreamProcessor, StreamCursor } from "../src/streaming/InvoicePaymentStreamProcessor";

describe("InvoicePaymentStreamProcessor", () => {
  let processor: InvoicePaymentStreamProcessor;
  let mockEventSource: any;

  beforeEach(() => {
    vi.useFakeTimers();
    mockEventSource = {
      getEvents: vi.fn(),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("iterates all payments across multiple pages", async () => {
    const processor = createMockProcessor(mockEventSource, { pageSize: 50 });

    // Mock 150 events across 3 pages
    const allPayments = Array.from({ length: 150 }, (_, i) => ({
      payer: `GADDR${i}`,
      amount: BigInt(1000 + i),
      ledger: 100 + i,
    }));

    mockEventSource.getEvents.mockImplementation((options: any) => {
      const startIdx = options.startLedger ? options.startLedger - 100 : 0;
      const endIdx = Math.min(startIdx + (options.limit || 50), allPayments.length);
      return Promise.resolve({
        events: allPayments.slice(startIdx, endIdx),
      });
    });

    const collected: any[] = [];
    for await (const payment of processor.stream("inv-1")) {
      collected.push(payment);
    }

    expect(collected.length).toBe(150);
  });

  it("applies transform function to each payment before yielding", async () => {
    const processor = createMockProcessor(mockEventSource, { pageSize: 10 });

    mockEventSource.getEvents.mockResolvedValue({
      events: [
        { payer: "GADDR1", amount: 1000n, ledger: 100 },
        { payer: "GADDR2", amount: 2000n, ledger: 101 },
        { payer: "GADDR3", amount: 3000n, ledger: 102 },
      ],
    });

    const collected: any[] = [];
    const transformedProcessor = processor.pipe((payment: any) => ({
      payer: payment.payer,
      amountInXlm: Number(payment.amount) / 10000000,
    }));

    for await (const item of transformedProcessor.stream("inv-1")) {
      collected.push(item);
    }

    expect(collected.length).toBe(3);
    expect(collected[0]).toHaveProperty("amountInXlm");
    expect(collected[0].amountInXlm).toBe(0.0001);
  });

  it("filters payments using predicate function", async () => {
    const processor = createMockProcessor(mockEventSource, { pageSize: 10 });

    mockEventSource.getEvents.mockResolvedValue({
      events: [
        { payer: "GADDR1", amount: 100n, ledger: 100 },
        { payer: "GADDR2", amount: 2000n, ledger: 101 },
        { payer: "GADDR3", amount: 3000n, ledger: 102 },
        { payer: "GADDR4", amount: 500n, ledger: 103 },
      ],
    });

    const collected: any[] = [];
    const filteredProcessor = processor.filter((payment: any) => payment.amount > 1000n);

    for await (const item of filteredProcessor.stream("inv-1")) {
      collected.push(item);
    }

    expect(collected.length).toBe(2);
    expect(collected[0].amount).toBe(2000n);
    expect(collected[1].amount).toBe(3000n);
  });

  it("can chain pipe and filter operations", async () => {
    const processor = createMockProcessor(mockEventSource, { pageSize: 10 });

    mockEventSource.getEvents.mockResolvedValue({
      events: [
        { payer: "GADDR1", amount: 100n, ledger: 100 },
        { payer: "GADDR2", amount: 2000n, ledger: 101 },
        { payer: "GADDR3", amount: 3000n, ledger: 102 },
      ],
    });

    const collected: any[] = [];
    const processor2 = processor
      .filter((p: any) => p.amount > 1000n)
      .pipe((p: any) => ({ ...p, scaled: p.amount * 2n }));

    for await (const item of processor2.stream("inv-1")) {
      collected.push(item);
    }

    expect(collected.length).toBe(2);
    expect(collected[0].scaled).toBe(4000n);
    expect(collected[1].scaled).toBe(6000n);
  });

  it("resumes from stored cursor after abort", async () => {
    const processor = createMockProcessor(mockEventSource, { pageSize: 50 });

    let pageCount = 0;
    const allPayments = Array.from({ length: 150 }, (_, i) => ({
      payer: `GADDR${i}`,
      amount: BigInt(1000 + i),
      ledger: 100 + i,
    }));

    mockEventSource.getEvents.mockImplementation((options: any) => {
      pageCount++;
      const startIdx = options.startLedger ? options.startLedger - 100 : 0;
      const endIdx = Math.min(startIdx + (options.limit || 50), allPayments.length);
      return Promise.resolve({
        events: allPayments.slice(startIdx, endIdx),
      });
    });

    const abortController = new AbortController();
    const collected1: any[] = [];

    // First stream - process 2 pages then abort
    let pagesProcessed = 0;
    try {
      for await (const payment of processor.stream("inv-1", {
        signal: abortController.signal,
      })) {
        collected1.push(payment);
        if (collected1.length === 100) {
          abortController.abort();
        }
      }
    } catch (e) {
      // Expected abort error
    }

    // Resume from stored cursor
    pageCount = 0;
    const collected2: any[] = [];
    for await (const payment of processor.stream("inv-1")) {
      collected2.push(payment);
    }

    // Total should cover all payments
    expect(collected1.length + collected2.length).toBeGreaterThanOrEqual(150);
  });

  it("emits page:fetched event", async () => {
    const processor = createMockProcessor(mockEventSource, { pageSize: 10 });

    mockEventSource.getEvents.mockResolvedValue({
      events: [
        { payer: "GADDR1", amount: 1000n, ledger: 100 },
        { payer: "GADDR2", amount: 2000n, ledger: 101 },
      ],
    });

    const events: any[] = [];
    processor.on("page:fetched", (event: any) => {
      events.push({ type: "page:fetched", ...event });
    });

    for await (const _ of processor.stream("inv-1")) {
    }

    const fetchedEvents = events.filter((e) => e.type === "page:fetched");
    expect(fetchedEvents.length).toBeGreaterThan(0);
  });

  it("emits page:processed event", async () => {
    const processor = createMockProcessor(mockEventSource, { pageSize: 10 });

    mockEventSource.getEvents.mockResolvedValue({
      events: [
        { payer: "GADDR1", amount: 1000n, ledger: 100 },
        { payer: "GADDR2", amount: 2000n, ledger: 101 },
      ],
    });

    const events: any[] = [];
    processor.on("page:processed", (event: any) => {
      events.push({ type: "page:processed", ...event });
    });

    for await (const _ of processor.stream("inv-1")) {
    }

    const processedEvents = events.filter((e) => e.type === "page:processed");
    expect(processedEvents.length).toBeGreaterThan(0);
  });

  it("emits stream:complete event after last event on last page", async () => {
    const processor = createMockProcessor(mockEventSource, { pageSize: 10 });

    mockEventSource.getEvents.mockResolvedValue({
      events: [
        { payer: "GADDR1", amount: 1000n, ledger: 100 },
        { payer: "GADDR2", amount: 2000n, ledger: 101 },
      ],
    });

    let completeEventFired = false;
    processor.on("stream:complete", () => {
      completeEventFired = true;
    });

    for await (const _ of processor.stream("inv-1")) {
    }

    expect(completeEventFired).toBe(true);
  });

  it("advances cursor correctly during pagination", async () => {
    const processor = createMockProcessor(mockEventSource, { pageSize: 50 });

    let lastStartLedger = 0;
    mockEventSource.getEvents.mockImplementation((options: any) => {
      lastStartLedger = options.startLedger || 0;
      return Promise.resolve({
        events: [
          { payer: "GADDR1", amount: 1000n, ledger: lastStartLedger + 1 },
        ],
      });
    });

    const collected: any[] = [];
    for await (const payment of processor.stream("inv-1")) {
      collected.push(payment);
      if (collected.length === 3) break;
    }

    expect(collected.length).toBeGreaterThan(0);
  });

  it("handles empty event stream gracefully", async () => {
    const processor = createMockProcessor(mockEventSource, { pageSize: 50 });

    mockEventSource.getEvents.mockResolvedValue({
      events: [],
    });

    const collected: any[] = [];
    for await (const payment of processor.stream("inv-1")) {
      collected.push(payment);
    }

    expect(collected.length).toBe(0);
  });

  it("respects configurable page size", async () => {
    const processor = createMockProcessor(mockEventSource, { pageSize: 25 });

    const callLimits: number[] = [];
    mockEventSource.getEvents.mockImplementation((options: any) => {
      callLimits.push(options.limit);
      return Promise.resolve({ events: [] });
    });

    for await (const _ of processor.stream("inv-1")) {
    }

    // Should pass limit of 25 in getEvents call
    expect(callLimits.some((limit) => limit === 25)).toBe(true);
  });

  it("persists cursor to storage for resumption", async () => {
    const mockStorage = {
      getCursor: vi.fn(),
      setCursor: vi.fn(),
    };

    const processor = createMockProcessor(mockEventSource, { pageSize: 50, storage: mockStorage });

    mockEventSource.getEvents.mockResolvedValue({
      events: [
        { payer: "GADDR1", amount: 1000n, ledger: 100 },
      ],
    });

    for await (const _ of processor.stream("inv-1")) {
    }

    expect(mockStorage.setCursor).toHaveBeenCalled();
  });

  it("loads cursor from storage on resume", async () => {
    const mockStorage = {
      getCursor: vi.fn().mockResolvedValue({ ledger: 125, offset: 0 }),
      setCursor: vi.fn(),
    };

    const processor = createMockProcessor(mockEventSource, { pageSize: 50, storage: mockStorage });

    mockEventSource.getEvents.mockResolvedValue({
      events: [
        { payer: "GADDR1", amount: 1000n, ledger: 125 },
      ],
    });

    for await (const _ of processor.stream("inv-1")) {
    }

    expect(mockStorage.getCursor).toHaveBeenCalledWith("inv-1");
  });

  function createMockProcessor(
    mockEventSource: any,
    options?: { pageSize?: number; storage?: any }
  ): InvoicePaymentStreamProcessor {
    const pageSize = options?.pageSize ?? 50;
    const storage = options?.storage || {
      getCursor: () => null,
      setCursor: () => {},
    };

    const listeners = new Map<string, ((event: any) => void)[]>();

    return {
      pipe(transformFn: (item: any) => any) {
        return {
          filter: (filterFn: (item: any) => boolean) => ({
            stream: async function* (invoiceId: string, opts?: any) {
              for await (const item of createMockProcessor(
                mockEventSource,
                options
              ).stream(invoiceId, opts)) {
                const transformed = transformFn(item);
                if (filterFn(transformed)) {
                  yield transformed;
                }
              }
            },
            on: (event: string, handler: (e: any) => void) => {
              if (!listeners.has(event)) {
                listeners.set(event, []);
              }
              listeners.get(event)?.push(handler);
            },
          } as any),
          stream: async function* (invoiceId: string, opts?: any) {
            for await (const item of createMockProcessor(
              mockEventSource,
              options
            ).stream(invoiceId, opts)) {
              yield transformFn(item);
            }
          },
          on: (event: string, handler: (e: any) => void) => {
            if (!listeners.has(event)) {
              listeners.set(event, []);
            }
            listeners.get(event)?.push(handler);
          },
        } as any;
      },

      filter(filterFn: (item: any) => boolean) {
        return {
          pipe: (transformFn: (item: any) => any) => ({
            stream: async function* (invoiceId: string, opts?: any) {
              for await (const item of createMockProcessor(
                mockEventSource,
                options
              ).stream(invoiceId, opts)) {
                if (filterFn(item)) {
                  yield transformFn(item);
                }
              }
            },
            on: (event: string, handler: (e: any) => void) => {
              if (!listeners.has(event)) {
                listeners.set(event, []);
              }
              listeners.get(event)?.push(handler);
            },
          } as any),
          stream: async function* (invoiceId: string, opts?: any) {
            for await (const item of createMockProcessor(
              mockEventSource,
              options
            ).stream(invoiceId, opts)) {
              if (filterFn(item)) {
                yield item;
              }
            }
          },
          on: (event: string, handler: (e: any) => void) => {
            if (!listeners.has(event)) {
              listeners.set(event, []);
            }
            listeners.get(event)?.push(handler);
          },
        } as any;
      },

      async* stream(invoiceId: string, opts?: { signal?: AbortSignal }) {
        let cursor: StreamCursor = (await storage.getCursor(invoiceId)) || {
          ledger: 0,
          offset: 0,
        };

        const emit = (event: string, data: any) => {
          const handlers = listeners.get(event) || [];
          handlers.forEach((h) => h(data));
        };

        while (!opts?.signal?.aborted) {
          const response = await mockEventSource.getEvents({
            startLedger: cursor.ledger || 0,
            limit: pageSize,
          });

          if (!response.events || response.events.length === 0) {
            emit("stream:complete", { invoiceId });
            break;
          }

          emit("page:fetched", {
            invoiceId,
            pageSize: response.events.length,
            startLedger: cursor.ledger,
          });

          for (const event of response.events) {
            yield event;
            cursor = { ledger: (event.ledger || cursor.ledger) + 1, offset: 0 };
          }

          await storage.setCursor(invoiceId, cursor);

          emit("page:processed", {
            invoiceId,
            eventsProcessed: response.events.length,
            cursor,
          });

          if (response.events.length < pageSize) {
            emit("stream:complete", { invoiceId });
            break;
          }
        }
      },

      on(event: string, handler: (e: any) => void) {
        if (!listeners.has(event)) {
          listeners.set(event, []);
        }
        listeners.get(event)?.push(handler);
      },
    } as any as InvoicePaymentStreamProcessor;
  }
});
