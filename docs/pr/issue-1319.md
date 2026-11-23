# Implement SDK metrics collection (#1319)

## Summary

Adds a first-class metrics collection subsystem to `@stellar-split/sdk`. The SDK already had a low-level
`MetricsRegistry` (counters/gauges/histograms) that was not exported from the package entry point and offered no
aggregation, reporting or diagnostics trail. This change introduces `SdkMetricsCollector`, a bounded, dependency-free
collector that covers the full collection → aggregation → reporting → tracking pipeline requested in the issue.

## What changed

- **New module `src/metricsCollection.ts`**
  - `SdkMetricsCollector` records **counters**, **gauges** and **timings** with arbitrary string labels.
  - `startTimer()` returns an idempotent callback so a duration is recorded exactly once.
  - `aggregate()` computes accurate `count`, `sum`, `min`, `max`, `mean`, `p50` and `p95` per series, plus totals by metric kind.
  - `report()` emits a structured `MetricsReport` (generation time, collection stats, aggregate and actionable insights such as high tail-latency warnings).
  - A bounded, ordered **tracking trail** (`trackedEvents()`) supports diagnostics without retaining payloads; truncation is reported explicitly.
  - Memory is bounded by `maxSeries`, `maxObservationsPerSeries` and `maxTrackedEvents`; collection can be toggled at runtime with `setEnabled()` and cleared with `reset()`.
  - Global labels can be merged into every observation via `labels`, and the clock is injectable for deterministic testing.
  - A shared `sdkMetrics` instance is exported for SDK-wide instrumentation.
- **Exports** added to `src/index.ts` (collector, shared instance and all public types).
- **Tests** added in `test/metricsCollection.test.ts` covering collection, disabled/invalid writes, global labels, idempotent timers, aggregation accuracy, report completeness, tracking bounds, observation caps, empty state and reset.

## Acceptance criteria addressed

- **Collection works** — counters, gauges, timings and labelled series are recorded.
- **Aggregation accurate** — mean/percentiles are computed from all retained observations and verified against known inputs.
- **Reporting complete** — `report()` includes timestamps, collection counters, full aggregates and insights.
- **Tracking efficient** — fixed-size ring-style trail and per-series observation caps prevent unbounded growth.
- **All tests pass** — dedicated Vitest suite plus the existing suite.
- **Actionable insights** — tail-latency, counter-volume, gauge-peak and empty-state hints are generated automatically.

## Testing

```bash
npx vitest run test/metricsCollection.test.ts
npm run lint
```

## Backwards compatibility

Additive only. No existing module or API is modified; the new collector is exported under new names.

closes #1319
