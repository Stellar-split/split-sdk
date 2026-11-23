import { describe, it, expect, beforeEach } from "vitest";
import {
  SdkMetricsCollector,
  type MetricsCollectorOptions,
} from "../src/metricsCollection.js";

describe("SdkMetricsCollector", () => {
  let now: number;
  let collector: SdkMetricsCollector;

  const make = (options: Partial<MetricsCollectorOptions> = {}) =>
    new SdkMetricsCollector({ now: () => now, ...options });

  beforeEach(() => {
    now = 1_700_000_000_000;
    collector = make();
  });

  describe("collection", () => {
    it("records counters, gauges and timings with labels", () => {
      collector.increment("payments.sent", 2, { network: "testnet" });
      collector.increment("payments.sent", 3, { network: "testnet" });
      collector.gauge("queue.depth", 7);
      collector.timing("rpc.latency", 120);

      expect(collector.events).toBe(4);
      expect(collector.size).toBe(3);

      const aggregate = collector.aggregate();
      expect(aggregate.totals).toEqual({ counter: 2, gauge: 1, timing: 1 });
      const counter = aggregate.series.find((s) => s.name === "payments.sent");
      expect(counter?.sum).toBe(5);
      expect(counter?.labels).toEqual({ network: "testnet" });
    });

    it("ignores disabled collectors, invalid values and negative counters", () => {
      const disabled = make({ enabled: false });
      disabled.increment("ignored");
      expect(disabled.events).toBe(0);

      collector.increment("no-negative", -5);
      collector.timing("no-negative-time", -1);
      collector.gauge("not-a-number", Number.NaN);
      expect(collector.events).toBe(0);
    });

    it("merges global labels and keeps label order irrelevant", () => {
      const labelled = make({ labels: { sdk: "stellar-split" } });
      labelled.increment("a", 1, { x: "1", y: "2" });
      labelled.increment("a", 1, { y: "2", x: "1" });

      expect(labelled.size).toBe(1);
      expect(labelled.aggregate().series[0]?.labels).toEqual({
        sdk: "stellar-split",
        x: "1",
        y: "2",
      });
    });

    it("records a timer once even when the callback is invoked repeatedly", () => {
      const finish = collector.startTimer("operation.duration");
      now += 45;
      expect(finish()).toBe(45);
      now += 100;
      expect(finish()).toBe(0);
      expect(collector.aggregate().series[0]?.sum).toBe(45);
    });
  });

  describe("aggregation accuracy", () => {
    it("computes count, sum, min, max, mean and percentiles", () => {
      [10, 20, 30, 40, 100].forEach((value) => collector.timing("latency", value));

      const summary = collector.aggregate().series[0]!;
      expect(summary.count).toBe(5);
      expect(summary.sum).toBe(200);
      expect(summary.min).toBe(10);
      expect(summary.max).toBe(100);
      expect(summary.mean).toBe(40);
      expect(summary.p50).toBe(30);
      expect(summary.p95).toBeCloseTo(88, 6);
      expect(summary.last).toBe(100);
    });
  });

  describe("reporting and tracking", () => {
    it("produces a complete report with actionable insights", () => {
      collector.timing("rpc.request", 10);
      collector.timing("rpc.request", 200);
      collector.increment("requests.ok");

      const report = collector.report();
      expect(report.collection.totalEvents).toBe(3);
      expect(report.collection.seriesCount).toBe(2);
      expect(report.aggregate.totals.timing).toBe(2);
      expect(report.insights.some((line) => line.includes("rpc.request"))).toBe(true);
      expect(report.insights.some((line) => line.includes("high tail latency"))).toBe(true);
    });

    it("keeps the tracking trail bounded and flags truncation", () => {
      const bounded = make({ maxTrackedEvents: 3 });
      for (let i = 0; i < 5; i += 1) {
        bounded.increment("events", 1, { i: String(i) });
      }

      const report = bounded.report();
      expect(report.collection.trackedEvents).toBe(3);
      expect(report.collection.trackedEventsTruncated).toBe(true);
      expect(bounded.trackedEvents().map((event) => event.labels.i)).toEqual(["2", "3", "4"]);
      expect(report.insights.some((line) => line.includes("truncated"))).toBe(true);
    });

    it("caps retained observations per series", () => {
      const bounded = make({ maxObservationsPerSeries: 2 });
      bounded.timing("latency", 5);
      bounded.timing("latency", 10);
      bounded.timing("latency", 15);
      expect(bounded.aggregate().series[0]?.count).toBe(2);
      expect(bounded.aggregate().series[0]?.min).toBe(10);
    });

    it("reports the empty state and can be reset", () => {
      expect(collector.report().insights[0]).toContain("No metrics recorded");
      collector.increment("one");
      collector.reset();
      expect(collector.events).toBe(0);
      expect(collector.size).toBe(0);
      expect(collector.trackedEvents()).toEqual([]);
    });
  });
});
