import type { MemoryReport } from "./types.js";

import * as v8 from "node:v8";
import * as fs from "node:fs/promises";
import * as path from "node:path";

let _cacheEntries = 0;
let _listenerCount = 0;

const CACHE_WARN_THRESHOLD = 1000;
const BYTES_PER_CACHE_ENTRY = 512;
const BYTES_PER_LISTENER = 256;

export function registerCacheEntry(): void {
  _cacheEntries++;
}

export function unregisterCacheEntry(): void {
  if (_cacheEntries > 0) _cacheEntries--;
}

export function registerListener(): void {
  _listenerCount++;
}

export function unregisterListener(): void {
  if (_listenerCount > 0) _listenerCount--;
}

export function trackMemoryUsage(): MemoryReport {
  const warnings: string[] = [];
  if (_cacheEntries > CACHE_WARN_THRESHOLD) {
    warnings.push(
      `Cache size exceeds threshold: ${_cacheEntries} entries (limit: ${CACHE_WARN_THRESHOLD})`
    );
  }
  const estimatedKB = Math.round(
    (_cacheEntries * BYTES_PER_CACHE_ENTRY + _listenerCount * BYTES_PER_LISTENER) / 1024
  );
  return { cacheEntries: _cacheEntries, listenerCount: _listenerCount, estimatedKB, warnings };
}

/** Error thrown when the profiler is used before initialization. */
export class ProfilerNotInitializedError extends Error {
  constructor() {
    super("MemoryProfiler has not been initialized. Call init() first.");
    this.name = "ProfilerNotInitializedError";
  }
}

/** Memory usage snapshot. */
export interface MemorySnapshot {
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
  timestamp: number;
}

/**
 * Tracks V8 memory usage metrics and supports heap snapshot export.
 */
export class MemoryProfiler {
  private _initialized = false;
  private _snapshots: MemorySnapshot[] = [];

  /** Initialize the profiler. */
  init(): void {
    this._initialized = true;
    this._snapshots = [];
  }

  /** Take a memory usage snapshot and return it. */
  snapshot(): MemorySnapshot {
    this._ensureInitialized();
    const mem = process.memoryUsage();
    const entry: MemorySnapshot = {
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      rss: mem.rss,
      external: mem.external,
      timestamp: Date.now(),
    };
    this._snapshots.push(entry);
    return entry;
  }

  /** Return all recorded snapshots. */
  getSnapshots(): MemorySnapshot[] {
    this._ensureInitialized();
    return [...this._snapshots];
  }

  /**
   * Export a V8 heap snapshot to a `.heapsnapshot` file for offline analysis.
   *
   * @param outputPath - Directory or full file path where the snapshot will be written.
   * @returns The full path of the written file.
   */
  async exportHeapSnapshot(outputPath: string): Promise<string> {
    this._ensureInitialized();

    let filePath = outputPath;
    try {
      const stat = await fs.stat(filePath);
      if (stat.isDirectory()) {
        filePath = path.join(filePath, `heap-${Date.now()}.heapsnapshot`);
      }
    } catch {
      if (!filePath.endsWith(".heapsnapshot")) {
        filePath = `${filePath}.heapsnapshot`;
      }
    }

    const snapshot = v8.writeHeapSnapshot(filePath);
    return snapshot;
  }

  /** Reset the profiler, clearing all recorded snapshots. */
  reset(): void {
    this._snapshots = [];
  }

  private _ensureInitialized(): void {
    if (!this._initialized) {
      throw new ProfilerNotInitializedError();
    }
  }
}

/** Default singleton profiler instance. */
export const memoryProfiler = new MemoryProfiler();
