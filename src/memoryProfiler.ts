import type { MemoryReport } from "./types.js";

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
