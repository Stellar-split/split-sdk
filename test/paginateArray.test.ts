import { describe, it, expect } from "vitest";
import { paginateArray } from "../src/horizonPaginator.js";
import { SdkError, SdkErrorCode } from "../src/errors.js";

describe("paginateArray", () => {
  const items = Array.from({ length: 25 }, (_, i) => `item-${i + 1}`);

  it("returns the first page when page=1", () => {
    const result = paginateArray(items, { page: 1, pageSize: 10 });
    expect(result.data).toEqual(items.slice(0, 10));
    expect(result.total).toBe(25);
    expect(result.totalPages).toBe(3);
    expect(result.hasNext).toBe(true);
    expect(result.hasPrev).toBe(false);
  });

  it("returns the second page", () => {
    const result = paginateArray(items, { page: 2, pageSize: 10 });
    expect(result.data).toEqual(items.slice(10, 20));
    expect(result.hasNext).toBe(true);
    expect(result.hasPrev).toBe(true);
  });

  it("returns the last (partial) page", () => {
    const result = paginateArray(items, { page: 3, pageSize: 10 });
    expect(result.data).toEqual(items.slice(20, 25));
    expect(result.hasNext).toBe(false);
    expect(result.hasPrev).toBe(true);
  });

  it("returns empty data for out-of-range page", () => {
    const result = paginateArray(items, { page: 10, pageSize: 10 });
    expect(result.data).toEqual([]);
    expect(result.total).toBe(25);
    expect(result.hasNext).toBe(false);
    expect(result.hasPrev).toBe(true);
  });

  it("throws SdkError when pageSize < 1", () => {
    expect(() => paginateArray(items, { page: 1, pageSize: 0 })).toThrow(
      SdkError,
    );
    expect(() => paginateArray(items, { page: 1, pageSize: 0 })).toThrow(
      /pageSize must be between 1 and 200/,
    );
  });

  it("throws SdkError when pageSize > 200", () => {
    expect(() => paginateArray(items, { page: 1, pageSize: 201 })).toThrow(
      SdkError,
    );
  });

  it("uses INVALID_RECIPIENT error code for bad pageSize", () => {
    try {
      paginateArray(items, { page: 1, pageSize: 0 });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SdkError);
      expect((err as SdkError).code).toBe(SdkErrorCode.INVALID_RECIPIENT);
    }
  });

  it("handles empty arrays gracefully", () => {
    const result = paginateArray([], { page: 1, pageSize: 10 });
    expect(result.data).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.totalPages).toBe(1);
    expect(result.hasNext).toBe(false);
    expect(result.hasPrev).toBe(false);
  });
});
