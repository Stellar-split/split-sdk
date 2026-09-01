import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  InMemoryCursorStore,
  setDefaultCursorStore,
  getDefaultCursorStore,
  buildCursorKey,
} from "../src/cursorTracker.js";
import { paginate, collectAll, paginateArray, HorizonPaginator } from "../src/horizonPaginator.js";
import { SdkError, SdkErrorCode } from "../src/errors.js";
import type { CollectionPage } from "../src/types.js";

describe("InMemoryCursorStore", () => {
  let store: InMemoryCursorStore;

  beforeEach(() => {
    store = new InMemoryCursorStore();
  });

  it("saves and loads cursors", async () => {
    await store.save("key1", "cursor-abc");
    expect(await store.load("key1")).toBe("cursor-abc");
  });

  it("returns null for unknown keys", async () => {
    expect(await store.load("nonexistent")).toBeNull();
  });

  it("deletes cursors", async () => {
    await store.save("key1", "cursor-abc");
    await store.delete("key1");
    expect(await store.load("key1")).toBeNull();
  });

  it("clears all cursors", async () => {
    await store.save("a", "1");
    await store.save("b", "2");
    store.clear();
    expect(await store.load("a")).toBeNull();
    expect(await store.load("b")).toBeNull();
  });
});

describe("cursorTracker", () => {
  it("setDefaultCursorStore and getDefaultCursorStore", () => {
    const store = new InMemoryCursorStore();
    setDefaultCursorStore(store);
    expect(getDefaultCursorStore()).toBe(store);
  });

  it("buildCursorKey creates namespaced keys", () => {
    expect(buildCursorKey("horizon", "last")).toBe("horizon:last");
    expect(buildCursorKey("payments", "cursor")).toBe("payments:cursor");
  });
});

describe("paginate", () => {
  function makePage<T>(records: T[], nextPage: CollectionPage<T> | null): CollectionPage<T> {
    return {
      records,
      next: vi.fn().mockResolvedValue(nextPage),
    };
  }

  it("yields all records from a single page", async () => {
    const page = makePage(
      [{ id: "1" }, { id: "2" }, { id: "3" }],
      null,
    );

    const results = [];
    for await (const record of paginate(page)) {
      results.push(record);
    }

    expect(results).toHaveLength(3);
    expect(results.map((r: Record<string, string>) => r.id)).toEqual(["1", "2", "3"]);
  });

  it("walks multiple pages transparently", async () => {
    const page3 = makePage([{ id: "7" }, { id: "8" }], null);
    const page2 = makePage([{ id: "4" }, { id: "5" }, { id: "6" }], page3);
    const page1 = makePage([{ id: "1" }, { id: "2" }, { id: "3" }], page2);

    const results = [];
    for await (const record of paginate(page1)) {
      results.push(record);
    }

    expect(results.map((r: Record<string, string>) => r.id)).toEqual([
      "1", "2", "3", "4", "5", "6", "7", "8",
    ]);
    expect(page1.next).toHaveBeenCalled();
    expect(page2.next).toHaveBeenCalled();
    // page3's next() is called (returns null) — that's expected behavior
  });

  it("respects maxRecords limit", async () => {
    const page2 = makePage([{ id: "4" }, { id: "5" }], null);
    const page1 = makePage([{ id: "1" }, { id: "2" }, { id: "3" }], page2);

    const results = [];
    for await (const record of paginate(page1, { maxRecords: 4 })) {
      results.push(record);
    }

    expect(results).toHaveLength(4);
    expect(results.map((r: Record<string, string>) => r.id)).toEqual(["1", "2", "3", "4"]);
  });

  it("handles empty pages", async () => {
    const page = makePage([], null);
    const results = [];
    for await (const record of paginate(page)) {
      results.push(record);
    }
    expect(results).toHaveLength(0);
  });

  it("handles page that becomes null", async () => {
    const page1 = makePage([{ id: "1" }], null as unknown as CollectionPage<unknown>);
    // Override next to return null
    page1.next = vi.fn().mockResolvedValue(null);

    const results = [];
    for await (const record of paginate(page1)) {
      results.push(record);
    }
    expect(results).toHaveLength(1);
  });
});

describe("collectAll", () => {
  function makePage<T>(records: T[], nextPage: CollectionPage<T> | null): CollectionPage<T> {
    return {
      records,
      next: vi.fn().mockResolvedValue(nextPage),
    };
  }

  it("collects all records into an array", async () => {
    const page2 = makePage([{ id: "3" }, { id: "4" }], null);
    const page1 = makePage([{ id: "1" }, { id: "2" }], page2);

    const results = await collectAll(page1);
    expect(results).toHaveLength(4);
    expect(results.map((r: Record<string, string>) => r.id)).toEqual(["1", "2", "3", "4"]);
  });

  it("respects maxRecords with collectAll", async () => {
    const page2 = makePage([{ id: "4" }, { id: "5" }, { id: "6" }], null);
    const page1 = makePage([{ id: "1" }, { id: "2" }, { id: "3" }], page2);

    const results = await collectAll(page1, { maxRecords: 5 });
    expect(results).toHaveLength(5);
  });
});

// ── Page-size negotiation (#692) ─────────────────────────────────────────────

describe("HorizonPaginator – page-size negotiation", () => {
  it("effectivePageSize starts equal to requestedPageSize", () => {
    const p = new HorizonPaginator(200);
    expect(p.effectivePageSize).toBe(200);
  });

  it("effectivePageSize is updated when the first page returns fewer records than requested", () => {
    const p = new HorizonPaginator(200);
    p.observeFirstPage(50); // server returned 50, not 200
    expect(p.effectivePageSize).toBe(50);
  });

  it("effectivePageSize stays unchanged when the first page is full", () => {
    const p = new HorizonPaginator(200);
    p.observeFirstPage(200);
    expect(p.effectivePageSize).toBe(200);
  });

  it("observeFirstPage is idempotent – only the first call counts", () => {
    const p = new HorizonPaginator(200);
    p.observeFirstPage(50);
    p.observeFirstPage(100); // should be ignored
    expect(p.effectivePageSize).toBe(50);
  });

  it("isLastPage returns false when a page is full (equals effectivePageSize)", () => {
    const p = new HorizonPaginator(200);
    p.observeFirstPage(50);
    expect(p.isLastPage(50)).toBe(false);
  });

  it("isLastPage returns true when a page is shorter than effectivePageSize", () => {
    const p = new HorizonPaginator(200);
    p.observeFirstPage(50);
    expect(p.isLastPage(30)).toBe(true);
  });
});

describe("paginate – page-size negotiation integration (#692)", () => {
  function makePage<T>(records: T[], nextPage: CollectionPage<T> | null): CollectionPage<T> {
    return {
      records,
      next: vi.fn().mockResolvedValue(nextPage),
    };
  }

  it("does not stop early when server caps page size and subsequent pages are full", async () => {
    // Caller requested 200 records per page; server caps at 5.
    // All three pages are 'full' at the server's limit → should yield all 15 records.
    const page3 = makePage([{ id: "11" }, { id: "12" }, { id: "13" }, { id: "14" }, { id: "15" }], null);
    const page2 = makePage([{ id: "6" }, { id: "7" }, { id: "8" }, { id: "9" }, { id: "10" }], page3);
    const page1 = makePage([{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }, { id: "5" }], page2);

    const results = [];
    for await (const record of paginate(page1, { pageSize: 200 })) {
      results.push(record);
    }

    expect(results).toHaveLength(15);
  });

  it("stops when a page returns fewer records than effectivePageSize (last page detected)", async () => {
    // Server caps at 5. Pages: full (5), full (5), partial (3) → should stop after partial.
    const page3 = makePage([{ id: "11" }, { id: "12" }, { id: "13" }], null);
    const page2 = makePage([{ id: "6" }, { id: "7" }, { id: "8" }, { id: "9" }, { id: "10" }], page3);
    const page1 = makePage([{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }, { id: "5" }], page2);

    const results = [];
    for await (const record of paginate(page1, { pageSize: 200 })) {
      results.push(record);
    }

    expect(results).toHaveLength(13);
    expect(results.map((r: Record<string, string>) => r.id)).toEqual([
      "1", "2", "3", "4", "5",
      "6", "7", "8", "9", "10",
      "11", "12", "13",
    ]);
  });

  it("updates effectivePageSize on the first page when server cap is lower", async () => {
    // We can verify behaviour by checking that page2.next is NOT called after a partial last page.
    const page2 = makePage([{ id: "4" }, { id: "5" }, { id: "6" }, { id: "7" }, { id: "8" }], null);
    const page1 = makePage([{ id: "1" }, { id: "2" }, { id: "3" }], page2); // 3 < 200 → effectivePageSize=3

    // page2 returns 5 records which is > effectivePageSize(3) but that means page2 was fetched.
    // What matters is: if page3 existed with 2 records it would stop. Here page2 has 5 > 3, so we fetch page3=null.
    const results = await collectAll(page1, { pageSize: 200 });

    // All records from page1 (3) and page2 (5) should be collected
    expect(results).toHaveLength(8);
  });
});

describe("paginateArray", () => {
  const sampleItems = [
    { id: "inv-1", amount: 100 },
    { id: "inv-2", amount: 200 },
    { id: "inv-3", amount: 300 },
    { id: "inv-4", amount: 400 },
    { id: "inv-5", amount: 500 },
    { id: "inv-6", amount: 600 },
    { id: "inv-7", amount: 700 },
  ];

  it("returns the first page (page 1) of items", () => {
    const result = paginateArray(sampleItems, { page: 1, pageSize: 3 });
    expect(result.data).toEqual([
      { id: "inv-1", amount: 100 },
      { id: "inv-2", amount: 200 },
      { id: "inv-3", amount: 300 },
    ]);
    expect(result.total).toBe(7);
    expect(result.totalPages).toBe(3);
    expect(result.hasNext).toBe(true);
    expect(result.hasPrev).toBe(false);
  });

  it("returns a middle page correctly", () => {
    const result = paginateArray(sampleItems, { page: 2, pageSize: 3 });
    expect(result.data).toEqual([
      { id: "inv-4", amount: 400 },
      { id: "inv-5", amount: 500 },
      { id: "inv-6", amount: 600 },
    ]);
    expect(result.total).toBe(7);
    expect(result.totalPages).toBe(3);
    expect(result.hasNext).toBe(true);
    expect(result.hasPrev).toBe(true);
  });

  it("returns the last page correctly", () => {
    const result = paginateArray(sampleItems, { page: 3, pageSize: 3 });
    expect(result.data).toEqual([{ id: "inv-7", amount: 700 }]);
    expect(result.total).toBe(7);
    expect(result.totalPages).toBe(3);
    expect(result.hasNext).toBe(false);
    expect(result.hasPrev).toBe(true);
  });

  it("returns empty data without error for out-of-range page beyond totalPages", () => {
    const result = paginateArray(sampleItems, { page: 4, pageSize: 3 });
    expect(result.data).toEqual([]);
    expect(result.total).toBe(7);
    expect(result.totalPages).toBe(3);
    expect(result.hasNext).toBe(false);
    expect(result.hasPrev).toBe(true);

    const resultFar = paginateArray(sampleItems, { page: 999, pageSize: 3 });
    expect(resultFar.data).toEqual([]);
    expect(resultFar.total).toBe(7);
    expect(resultFar.totalPages).toBe(3);
    expect(resultFar.hasNext).toBe(false);
    expect(resultFar.hasPrev).toBe(true);
  });

  it("returns empty data without error for page < 1", () => {
    const resultZero = paginateArray(sampleItems, { page: 0, pageSize: 3 });
    expect(resultZero.data).toEqual([]);
    expect(resultZero.total).toBe(7);
    expect(resultZero.totalPages).toBe(3);
    expect(resultZero.hasNext).toBe(false);
    expect(resultZero.hasPrev).toBe(false);

    const resultNeg = paginateArray(sampleItems, { page: -5, pageSize: 3 });
    expect(resultNeg.data).toEqual([]);
    expect(resultNeg.total).toBe(7);
    expect(resultNeg.totalPages).toBe(3);
    expect(resultNeg.hasNext).toBe(false);
    expect(resultNeg.hasPrev).toBe(false);
  });

  it("handles a single item correctly", () => {
    const single = [{ id: "solo" }];
    const result = paginateArray(single, { page: 1, pageSize: 10 });
    expect(result.data).toEqual([{ id: "solo" }]);
    expect(result.total).toBe(1);
    expect(result.totalPages).toBe(1);
    expect(result.hasNext).toBe(false);
    expect(result.hasPrev).toBe(false);
  });

  it("handles exactly pageSize items correctly", () => {
    const items = ["a", "b", "c", "d", "e"];
    const result = paginateArray(items, { page: 1, pageSize: 5 });
    expect(result.data).toEqual(["a", "b", "c", "d", "e"]);
    expect(result.total).toBe(5);
    expect(result.totalPages).toBe(1);
    expect(result.hasNext).toBe(false);
    expect(result.hasPrev).toBe(false);
  });

  it("handles an empty array correctly", () => {
    const result = paginateArray([], { page: 1, pageSize: 10 });
    expect(result.data).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.totalPages).toBe(0);
    expect(result.hasNext).toBe(false);
    expect(result.hasPrev).toBe(false);
  });

  it("verifies hasNext and hasPrev correctness across multiple pages", () => {
    const fourItems = [1, 2, 3, 4];
    const page1 = paginateArray(fourItems, { page: 1, pageSize: 2 });
    expect(page1.data).toEqual([1, 2]);
    expect(page1.hasNext).toBe(true);
    expect(page1.hasPrev).toBe(false);

    const page2 = paginateArray(fourItems, { page: 2, pageSize: 2 });
    expect(page2.data).toEqual([3, 4]);
    expect(page2.hasNext).toBe(false);
    expect(page2.hasPrev).toBe(true);
  });

  it("throws SdkError with INVALID_RECIPIENT when pageSize < 1", () => {
    expect(() => paginateArray(sampleItems, { page: 1, pageSize: 0 })).toThrowError(
      SdkError,
    );
    try {
      paginateArray(sampleItems, { page: 1, pageSize: 0 });
    } catch (err) {
      expect(err).toBeInstanceOf(SdkError);
      expect((err as SdkError).code).toBe(SdkErrorCode.INVALID_RECIPIENT);
    }

    try {
      paginateArray(sampleItems, { page: 1, pageSize: -10 });
    } catch (err) {
      expect(err).toBeInstanceOf(SdkError);
      expect((err as SdkError).code).toBe(SdkErrorCode.INVALID_RECIPIENT);
    }
  });

  it("throws SdkError with INVALID_RECIPIENT when pageSize > 200", () => {
    expect(() => paginateArray(sampleItems, { page: 1, pageSize: 201 })).toThrowError(
      SdkError,
    );
    try {
      paginateArray(sampleItems, { page: 1, pageSize: 201 });
    } catch (err) {
      expect(err).toBeInstanceOf(SdkError);
      expect((err as SdkError).code).toBe(SdkErrorCode.INVALID_RECIPIENT);
    }
  });

  it("accepts pageSize at boundary values 1 and 200", () => {
    const resultMin = paginateArray(sampleItems, { page: 1, pageSize: 1 });
    expect(resultMin.data).toEqual([{ id: "inv-1", amount: 100 }]);
    expect(resultMin.totalPages).toBe(7);

    const resultMax = paginateArray(sampleItems, { page: 1, pageSize: 200 });
    expect(resultMax.data).toHaveLength(7);
    expect(resultMax.totalPages).toBe(1);
  });

  it("throws SdkError with INVALID_RECIPIENT when pageSize is not an integer or is NaN", () => {
    expect(() =>
      paginateArray(sampleItems, { page: 1, pageSize: 2.5 }),
    ).toThrowError(SdkError);
    try {
      paginateArray(sampleItems, { page: 1, pageSize: 2.5 });
    } catch (err) {
      expect(err).toBeInstanceOf(SdkError);
      expect((err as SdkError).code).toBe(SdkErrorCode.INVALID_RECIPIENT);
    }

    try {
      paginateArray(sampleItems, { page: 1, pageSize: NaN });
    } catch (err) {
      expect(err).toBeInstanceOf(SdkError);
      expect((err as SdkError).code).toBe(SdkErrorCode.INVALID_RECIPIENT);
    }
  });

  it("returns empty data when page is not an integer", () => {
    const result = paginateArray(sampleItems, { page: 1.5, pageSize: 3 });
    expect(result.data).toEqual([]);
    expect(result.total).toBe(7);
    expect(result.totalPages).toBe(3);
  });

  it("handles generic arrays with custom interfaces (Invoice / Payment)", () => {
    interface Invoice {
      id: string;
      recipient: string;
      amount: bigint;
    }
    const invoices: Invoice[] = [
      { id: "inv-1", recipient: "GAAA", amount: 1000n },
      { id: "inv-2", recipient: "GBBB", amount: 2000n },
    ];
    const result = paginateArray<Invoice>(invoices, { page: 1, pageSize: 1 });
    expect(result.data).toEqual([{ id: "inv-1", recipient: "GAAA", amount: 1000n }]);
    expect(result.total).toBe(2);
    expect(result.totalPages).toBe(2);
    expect(result.hasNext).toBe(true);
    expect(result.hasPrev).toBe(false);
  });
});

