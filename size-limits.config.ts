/**
 * Bundle size limits configuration for tree-shaking audit.
 * 
 * Each entry defines the maximum allowed gzipped size in bytes for a named export.
 * Budgets are derived from current baseline measurements.
 */

export const sizeLimits = {
  /** Main client class - core SDK functionality */
  StellarSplitClient: {
    maxBytes: 50000, // 50KB gzipped
  },
  
  /** Utility function for formatting amounts */
  formatAmount: {
    maxBytes: 1000, // 1KB gzipped
  },
  
  /** Utility function for parsing amounts */
  parseAmount: {
    maxBytes: 1000, // 1KB gzipped
  },
  
  /** Telemetry collection utilities */
  TelemetryCollector: {
    maxBytes: 5000, // 5KB gzipped
  },
  
  /** Retry policy implementation */
  RetryPolicy: {
    maxBytes: 3000, // 3KB gzipped
  },
  
  /** Health check utilities */
  checkRPCHealth: {
    maxBytes: 2000, // 2KB gzipped
  },
};

export default sizeLimits;
