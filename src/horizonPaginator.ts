/**
 * Horizon collection paginator.
 *
 * Wraps cursor-based Horizon collection endpoints and exposes an async
 * iterator that transparently walks all pages, yielding records until
 * the collection is exhausted or a configurable max-records limit is hit.
 *
 * Integrates with {@link cursorTracker} to persist the last-seen paging
 * token for resumable pagination.
 */

import type { CollectionPage, HorizonPaginatorOptions } from "./types.js";
import { buildCursorKey, getDefaultCursorStore } from "./cursorTracker.js";
import { StellarSplitError } from "./errors.js";

/** Default namespace for cursor store keys. */
const DEFAULT_NAMESPACE = "horizon";

/**
 * Create an async iterable iterator that walks all pages of a Horizon
 * collection endpoint.
 *
 * @param initialPage - The first page of results (obtained from a Horizon call builder).
 * @param opts - Optional configuration for record limits and cursor persistence.
 *
 * @example
 * ```typescript
 * const server = new Server("https://horizon.stellar.org");
 * const page = await server.payments().forAccount(addr).limit(200).call();
 *
 * for await (const payment of paginate(page, { maxRecords: 500 })) {
 *   console.log(payment);
 * }
 * ```
 */
export async function* paginate<T>(
  initialPage: CollectionPage<T>,
  opts?: HorizonPaginatorOptions,
): AsyncIterableIterator<T> {
  const maxRecords = opts?.maxRecords;
  const cursorStore = opts?.cursorStore ?? getDefaultCursorStore();
  const namespace = opts?.cursorNamespace ?? DEFAULT_NAMESPACE;

  let yielded = 0;
  let currentPage: CollectionPage<T> | null = initialPage;

  while (currentPage) {
    const records = currentPage.records ?? [];
    const batch = maxRecords !== undefined
      ? records.slice(0, maxRecords - yielded)
      : records;

    for (const record of batch) {
      if (maxRecords !== undefined && yielded >= maxRecords) return;
      yielded++;
      yield record;
    }

    // Persist the cursor of the last record we just yielded
    if (batch.length > 0) {
      const lastRecord = batch[batch.length - 1] as unknown;
      if (lastRecord && typeof (lastRecord as Record<string, unknown>).paging_token === "string") {
        const token = (lastRecord as Record<string, unknown>).paging_token as string;
        if (cursorStore) {
          const cursorKey = buildCursorKey(namespace, "last");
          await cursorStore.save(cursorKey, token).catch(() => {
            // Cursor save failures are non-fatal
          });
        }
      }
    }

    if (maxRecords !== undefined && yielded >= maxRecords) return;

    // Fetch next page
    currentPage = await currentPage.next();
  }
}

/**
 * Collect all records from a paginated collection into a single array.
 *
 * Convenience wrapper around {@link paginate}.
 *
 * @param initialPage - The first page of results.
 * @param opts - Optional configuration.
 * @returns All records across all pages (up to maxRecords).
 */
export async function collectAll<T>(
  initialPage: CollectionPage<T>,
  opts?: HorizonPaginatorOptions,
): Promise<T[]> {
  const results: T[] = [];
  for await (const record of paginate(initialPage, opts)) {
    results.push(record);
  }
  return results;
}

/**
 * Page a plain array in memory, returning a slice with pagination metadata.
 *
 * @param items - The full array of items to paginate.
 * @param opts - Pagination options: `page` (1-indexed) and `pageSize` (1-200).
 * @returns An object with `data`, `total`, `totalPages`, `hasNext`, and `hasPrev`.
 *
 * @throws {StellarSplitError} If `pageSize` is outside the range 1-200.
 *
 * @example
 * ```typescript
 * const result = paginateArray([1, 2, 3, 4, 5], { page: 1, pageSize: 2 });
 * // { data: [1, 2], total: 5, totalPages: 3, hasNext: true, hasPrev: false }
 * ```
 */
export function paginateArray<T>(
  items: T[],
  opts: { page: number; pageSize: number },
): { data: T[]; total: number; totalPages: number; hasNext: boolean; hasPrev: boolean } {
  const { page, pageSize } = opts;

  if (pageSize < 1 || pageSize > 200) {
    throw new StellarSplitError("pageSize must be between 1 and 200", "INVALID_RECIPIENT");
  }

  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  if (page < 1 || page > totalPages) {
    return {
      data: [],
      total,
      totalPages,
      hasNext: false,
      hasPrev: page > 1,
    };
  }

  const startIndex = (page - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, total);
  const data = items.slice(startIndex, endIndex);

  return {
    data,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
}
