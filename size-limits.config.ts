/**
 * Bundle size budgets for the SDK.
 *
 * Each entry maps a build artifact to its maximum allowed size in bytes.
 * The `baseline` value records the size measured before optimization so
 * regressions and improvements can be tracked over time.
 */
export interface SizeLimit {
  /** Maximum allowed size in bytes. */
  limit: number;
  /** Size in bytes recorded before bundle optimization. */
  baseline: number;
}

export const sizeLimits: Record<string, SizeLimit> = {
  'dist/index.js': { limit: 120 * 1024, baseline: 148 * 1024 },
  'dist/index.min.js': { limit: 48 * 1024, baseline: 61 * 1024 },
  'dist/index.min.js.gz': { limit: 16 * 1024, baseline: 21 * 1024 },
};

/**
 * Returns the percentage reduction achieved against the recorded baseline.
 * Positive values indicate the artifact is smaller than the baseline.
 */
export function reductionPercent(artifact: string, currentSize: number): number {
  const entry = sizeLimits[artifact];
  if (!entry || entry.baseline === 0) {
    return 0;
  }
  return ((entry.baseline - currentSize) / entry.baseline) * 100;
}

/**
 * Returns true when the artifact is within its configured size limit.
 */
export function withinLimit(artifact: string, currentSize: number): boolean {
  const entry = sizeLimits[artifact];
  if (!entry) {
    return true;
  }
  return currentSize <= entry.limit;
}
