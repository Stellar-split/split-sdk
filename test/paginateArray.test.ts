import { describe, it, expect } from "vitest";
import { paginateArray } from "../src/horizonPaginator.js";
import { StellarSplitError } from "../src/errors.js";

describe("paginateArray", () => {
  const items = Array.from({ length: 10 }, (_, i) => i + 1); // [1..10]

  it("returns the first pageSize items on page 1", () => {
    const result = paginateArray(items, { page: 1, pageSize: 3 });
    expect(result.data).toEqual([1, 2, 3]);
    expect(result.total).toBe(10);
    expect(result.totalPages).toBe(4);
    expect(result.hasNext).toBe(true);
    expect(result.hasPrev).toBe(false);
  });

  it("returns the last page when page equals totalPages", () => {
    const result = paginateArray(items, { page: 4, pageSize: 3 });
    expect(result.data).toEqual([10]);
    expect(result.total).toBe(10);
    expect(result.totalPages).toBe(4);
    expect(result.hasNext).toBe(false);
    expect(result.hasPrev).toBe(true);
  });

  it("returns an empty data array for an out-of-range page without throwing", () => {
    const result = paginateArray(items, { page: 99, pageSize: 3 });
    expect(result.data).toEqual([]);
    expect(result.total).toBe(10);
    expect(result.totalPages).toBe(4);
    expect(result.hasNext).toBe(false);
    expect(result.hasPrev).toBe(true);
  });

  it("handles a single item", () => {
    const result = paginateArray([42], { page: 1, pageSize: 5 });
    expect(result.data).toEqual([42]);
    expect(result.total).toBe(1);
    expect(result.totalPages).toBe(1);
    expect(result.hasNext).toBe(false);
    expect(result.hasPrev).toBe(false);
  });

  it("handles exactly pageSize items (single page)", () => {
    const exact = [1, 2, 3, 4, 5];
    const result = paginateArray(exact, { page: 1, pageSize: 5 });
    expect(result.data).toEqual([1, 2, 3, 4, 5]);
    expect(result.total).toBe(5);
    expect(result.totalPages).toBe(1);
    expect(result.hasNext).toBe(false);
    expect(result.hasPrev).toBe(false);
  });

  it("exposes pagination metadata on an intermediate page", () => {
    const result = paginateArray(items, { page: 2, pageSize: 4 });
    expect(result.data).toEqual([5, 6, 7, 8]);
    expect(result.total).toBe(10);
    expect(result.totalPages).toBe(3);
    expect(result.hasNext).toBe(true);
    expect(result.hasPrev).toBe(true);
  });

  it("throws StellarSplitError with code INVALID_RECIPIENT when pageSize is below 1", () => {
    expect(() => paginateArray(items, { page: 1, pageSize: 0 })).toThrow(StellarSplitError);
    try {
      paginateArray(items, { page: 1, pageSize: 0 });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(StellarSplitError);
      expect((err as StellarSplitError).code).toBe("INVALID_RECIPIENT");
    }
  });

  it("throws StellarSplitError with code INVALID_RECIPIENT when pageSize exceeds 200", () => {
    expect(() => paginateArray(items, { page: 1, pageSize: 201 })).toThrow(StellarSplitError);
    try {
      paginateArray(items, { page: 1, pageSize: 201 });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(StellarSplitError);
      expect((err as StellarSplitError).code).toBe("INVALID_RECIPIENT");
    }
  });

  it("accepts the maximum pageSize of 200", () => {
    const big = Array.from({ length: 200 }, (_, i) => i);
    const result = paginateArray(big, { page: 1, pageSize: 200 });
    expect(result.data).toHaveLength(200);
    expect(result.totalPages).toBe(1);
    expect(result.hasNext).toBe(false);
  });

  it("returns an empty page for an empty array", () => {
    const result = paginateArray([], { page: 1, pageSize: 10 });
    expect(result.data).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.totalPages).toBe(1);
    expect(result.hasNext).toBe(false);
    expect(result.hasPrev).toBe(false);
  });

  it("does not throw for an out-of-range page at or below zero", () => {
    const result = paginateArray(items, { page: 0, pageSize: 3 });
    expect(result.data).toEqual([]);
    expect(result.hasNext).toBe(false);
    expect(result.hasPrev).toBe(false);
  });
});