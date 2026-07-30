/**
 * Percentile computation helpers.
 *
 * Extracted from {@link FeeTrendAnalyzer} (../fees/trend.js) so the
 * statistics logic can be exercised independently of Horizon/network
 * concerns.
 */

/**
 * Computes the value at `percentileTarget` using linear interpolation
 * between closest ranks (the same convention as numpy's default
 * `"linear"` interpolation method).
 *
 * @param values - Unsorted sample values.
 * @param percentileTarget - Target percentile in the range [0, 100].
 */
export function percentile(values: readonly number[], percentileTarget: number): number {
  if (values.length === 0) {
    throw new RangeError("Cannot compute a percentile of an empty sample set");
  }
  if (percentileTarget < 0 || percentileTarget > 100) {
    throw new RangeError(`Percentile must be between 0 and 100, got ${percentileTarget}`);
  }

  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) {
    return sorted[0] as number;
  }

  const rank = (percentileTarget / 100) * (sorted.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);

  if (lowerIndex === upperIndex) {
    return sorted[lowerIndex] as number;
  }

  const lowerValue = sorted[lowerIndex] as number;
  const upperValue = sorted[upperIndex] as number;
  const fraction = rank - lowerIndex;

  return lowerValue + (upperValue - lowerValue) * fraction;
}
