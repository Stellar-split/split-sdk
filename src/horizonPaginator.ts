/**
 * Horizon collection paginator.
 *
 * Wraps cursor-based Horizon collection endpoints and exposes an async
 * iterator that transparently walks all pages, yielding records until
 * the collection is exhausted or a configurable max-records limit is hit.
 *
 * Integrates with {@link cursorTracker} to persist the last-seen paging
 * token for resumable pagination.
 *
 * ## Automatic page-size negotiation (#692)
 *
 * When the configured `pageSize` exceeds the server's actual maximum,
 * Horizon silently returns fewer records than requested. The paginator
 * detects this on the first response: if the first page returns fewer
 * records than `pageSize`, `effectivePageSize` is updated to the actual
 * count. Subsequent pages use `effectivePageSize` to decide whether a page
 * is the last one, preventing premature termination.
 *
 * `effectivePageSize` is exposed as a read-only property for debugging.
 */

import type { CollectionPage, HorizonPaginatorOptions } from "./types.js";
import { buildCursorKey, getDefaultCursorStore } from "./cursorTracker.js";
import { SdkError, SdkErrorCode } from "./errors.js";

/** Default namespace for cursor store keys. */
const DEFAULT_NAMESPACE = "horizon";

/**
 * Stateful paginator for a Horizon collection endpoint.
 *
 * Prefer the {@link HorizonPaginator} class when you need access to
 * `effectivePageSize`. Use the free-standing {@link paginate} or
 * {@link collectAll} helpers for a simpler one-shot API.
 */
export class HorizonPaginator<T> {
  /** The page size originally requested by the caller. */
  readonly requestedPageSize: number;

  /**
   * The effective page size derived from the first response.
   *
   * Equals `requestedPageSize` until the first page is received. If the
   * first page returns fewer records than `requestedPageSize`, this is
   * updated to the actual count so subsequent pages are judged correctly.
   * Exposed as a read-only property for debugging.
   */
  get effectivePageSize(): number {
    return this._effectivePageSize;
  }

  private _effectivePageSize: number;
  private _firstPageSeen = false;

  constructor(requestedPageSize: number) {
    this.requestedPageSize = requestedPageSize;
    this._effectivePageSize = requestedPageSize;
  }

  /**
   * Observe the first page response to negotiate the effective page size.
   * Called internally by {@link paginate}.
   *
   * @param recordCount - Number of records returned in the first page.
   */
  observeFirstPage(recordCount: number): void {
    if (this._firstPageSeen) return;
    this._firstPageSeen = true;
    if (recordCount < this.requestedPageSize) {
      // Server returned fewer records than requested — adapt to the actual
      // maximum so we don't mistake later full pages for the last one.
      this._effectivePageSize = recordCount;
    }
  }

  /**
   * Returns `true` when the given page should be treated as the last page
   * (i.e. the server has no more data to return).
   */
  isLastPage(recordCount: number): boolean {
    // A page with 0 records (or fewer than effectivePageSize after negotiation)
    // means the collection is exhausted.
    return recordCount < this._effectivePageSize;
  }
}

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
  const pageSize = opts?.pageSize ?? 200;
  const cursorStore = opts?.cursorStore ?? getDefaultCursorStore();
  const namespace = opts?.cursorNamespace ?? DEFAULT_NAMESPACE;

  const paginator = new HorizonPaginator<T>(pageSize);

  let yielded = 0;
  let currentPage: CollectionPage<T> | null = initialPage;
  let isFirst = true;

  while (currentPage) {
    const records = currentPage.records ?? [];
    const batch = maxRecords !== undefined
      ? records.slice(0, maxRecords - yielded)
      : records;

    // ── Page-size negotiation ──────────────────────────────────────────────
    // On the first page, observe the actual record count to detect whether
    // the server silently capped our requested page size.
    if (isFirst) {
      paginator.observeFirstPage(records.length);
      isFirst = false;
    }

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

    // ── Termination: use effectivePageSize to detect last page ─────────────
    // After negotiation, a page with fewer records than effectivePageSize
    // means the collection is exhausted — no need to fetch further.
    if (paginator.isLastPage(records.length)) {
      return;
    }

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

// ─────────────────────────────────────────────────────────────────────────────
// #618 — Local array pagination helper (paginateArray)
// -----------------------------------------------------------------------------
// Spec + resolved anomalies: RESOLUCION_ANOMALIAS_618.md (experimento_autonomia).

/** Options for {@link paginateArray}. */
export interface PaginateArrayOptions {
  /** 1-indexed page number. */
  page: number;
  /** Page size; must be between 1 and 200 inclusive. */
  pageSize: number;
}

/** Result of paginating a local array. */
export interface PaginateArrayResult<T> {
  /** Items for the requested page. */
  data: T[];
  /** Total number of items in the source array. */
  total: number;
  /** Total number of pages. */
  totalPages: number;
  /** Whether a next page exists. */
  hasNext: boolean;
  /** Whether a previous page exists. */
  hasPrev: boolean;
}

/**
 * Paginate a local in-memory array into 1-indexed pages.
 *
 * Pure function: the input array is never mutated. An out-of-range `page`
 * (including 0, negatives and non-integers) returns `data: []` without
 * throwing. An empty array yields `totalPages: 0`.
 *
 * @param items - The full array to paginate.
 * @param opts  - Page number (1-indexed) and page size.
 * @returns The requested page plus pagination metadata.
 * @throws {SdkError} if `pageSize` is not an integer between 1 and 200.
 */
export function paginateArray<T>(
  items: T[],
  opts: PaginateArrayOptions,
): PaginateArrayResult<T> {
  const { page, pageSize } = opts;

  // Spec: pageSize must be between 1 and 200 (inclusive).
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
    // SdkErrorCode only exposes INVALID_RECIPIENT as the closest
    // invalid-argument code (issue #607 enum is intentionally closed).
    // Extending the enum is out of scope for this issue (see PR notes).
    throw new SdkError(
      `pageSize must be an integer between 1 and 200, got ${pageSize}`,
      SdkErrorCode.INVALID_RECIPIENT,
      { page, pageSize },
    );
  }

  const total = items.length;
  const totalPages = Math.ceil(total / pageSize);

  // Out-of-range page (page < 1 or beyond totalPages) → empty page, no error.
  if (!Number.isInteger(page) || page < 1 || page > totalPages) {
    return { data: [], total, totalPages, hasNext: false, hasPrev: false };
  }

  const start = (page - 1) * pageSize;
  const data = items.slice(start, start + pageSize);

  return { data, total, totalPages, hasNext: page < totalPages, hasPrev: page > 1 };
}
