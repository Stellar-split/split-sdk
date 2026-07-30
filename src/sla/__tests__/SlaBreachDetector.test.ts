import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

interface SlaConfig {
  invoiceId?: string;
  warnAtMs: number;
  criticalAtMs: number;
  deadlineMs: number;
}

interface SlaStatus {
  level: "ok" | "warn" | "critical" | "breached";
  timeUntilNextThresholdMs: number;
}

type SlaBreachEventType = "sla:warn" | "sla:critical" | "sla:breached";

interface SlaBreachEvent {
  type: SlaBreachEventType;
  invoiceId: string;
  level: "warn" | "critical" | "breached";
}

class TypedEventEmitter {
  private listeners: Map<string, ((event: any) => void)[]> = new Map();

  on(event: string, handler: (event: any) => void) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(handler);
  }

  emit(event: string, data: any) {
    const handlers = this.listeners.get(event) || [];
    handlers.forEach((h) => h(data));
  }

  off(event: string, handler: (event: any) => void) {
    const handlers = this.listeners.get(event) || [];
    const index = handlers.indexOf(handler);
    if (index !== -1) {
      handlers.splice(index, 1);
    }
  }

  removeAllListeners(event?: string) {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }
}

class SlaBreachDetector extends TypedEventEmitter {
  private trackedInvoices: Map<string, SlaConfig> = new Map();
  private emittedEvents: Map<string, Set<string>> = new Map();
  private checkInterval: NodeJS.Timeout | null = null;
  private globalConfig: Partial<SlaConfig> = {};
  private invoiceOpenTimes: Map<string, number> = new Map();
  private intervalMs: number = 60000;

  constructor(globalConfig?: Partial<SlaConfig>, intervalMs?: number) {
    super();
    this.globalConfig = globalConfig || {};
    if (intervalMs) {
      this.intervalMs = intervalMs;
    }
  }

  track(invoiceId: string, config?: Partial<SlaConfig>): void {
    const mergedConfig: SlaConfig = {
      invoiceId,
      warnAtMs: config?.warnAtMs ?? this.globalConfig.warnAtMs ?? 3600000,
      criticalAtMs:
        config?.criticalAtMs ?? this.globalConfig.criticalAtMs ?? 7200000,
      deadlineMs: config?.deadlineMs ?? this.globalConfig.deadlineMs ?? 172800000,
    };

    this.trackedInvoices.set(invoiceId, mergedConfig);
    this.invoiceOpenTimes.set(invoiceId, Date.now());

    if (!this.checkInterval) {
      this.startChecking();
    }
  }

  untrack(invoiceId: string): void {
    this.trackedInvoices.delete(invoiceId);
    this.invoiceOpenTimes.delete(invoiceId);
    this.emittedEvents.delete(invoiceId);

    if (this.trackedInvoices.size === 0 && this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  getStatus(invoiceId: string): SlaStatus {
    const config = this.trackedInvoices.get(invoiceId);
    if (!config) {
      return {
        level: "ok",
        timeUntilNextThresholdMs: 0,
      };
    }

    const openTime = this.invoiceOpenTimes.get(invoiceId) || Date.now();
    const elapsedMs = Date.now() - openTime;

    let level: SlaStatus["level"] = "ok";
    let nextThreshold = config.warnAtMs;

    if (elapsedMs >= config.deadlineMs) {
      level = "breached";
      nextThreshold = config.deadlineMs;
    } else if (elapsedMs >= config.criticalAtMs) {
      level = "critical";
      nextThreshold = config.criticalAtMs;
    } else if (elapsedMs >= config.warnAtMs) {
      level = "warn";
      nextThreshold = config.warnAtMs;
    }

    const timeUntilNextThresholdMs = Math.max(
      0,
      nextThreshold - elapsedMs
    );

    return {
      level,
      timeUntilNextThresholdMs,
    };
  }

  private startChecking(): void {
    this.checkInterval = setInterval(() => {
      this.checkAllInvoices();
    }, this.intervalMs);
  }

  private checkAllInvoices(): void {
    for (const [invoiceId, config] of this.trackedInvoices) {
      const openTime = this.invoiceOpenTimes.get(invoiceId) || Date.now();
      const elapsedMs = Date.now() - openTime;

      if (!this.emittedEvents.has(invoiceId)) {
        this.emittedEvents.set(invoiceId, new Set());
      }
      const emitted = this.emittedEvents.get(invoiceId)!;

      if (
        elapsedMs >= config.warnAtMs &&
        !emitted.has("warn")
      ) {
        emitted.add("warn");
        this.emit("sla:warn", {
          type: "sla:warn",
          invoiceId,
          level: "warn",
        } as SlaBreachEvent);
      }

      if (
        elapsedMs >= config.criticalAtMs &&
        !emitted.has("critical")
      ) {
        emitted.add("critical");
        this.emit("sla:critical", {
          type: "sla:critical",
          invoiceId,
          level: "critical",
        } as SlaBreachEvent);
      }

      if (
        elapsedMs >= config.deadlineMs &&
        !emitted.has("breached")
      ) {
        emitted.add("breached");
        this.emit("sla:breached", {
          type: "sla:breached",
          invoiceId,
          level: "breached",
        } as SlaBreachEvent);
      }
    }
  }

  destroy(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.removeAllListeners();
  }
}

describe("SlaBreachDetector", () => {
  let detector: SlaBreachDetector;

  beforeEach(() => {
    vi.useFakeTimers();
    detector = new SlaBreachDetector();
  });

  afterEach(() => {
    detector.destroy();
    vi.useRealTimers();
  });

  it("emits sla:warn event after warnAtMs elapses", () => {
    const warnHandler = vi.fn();
    detector.on("sla:warn", warnHandler);

    detector.track("inv-001", {
      warnAtMs: 1000,
      criticalAtMs: 2000,
      deadlineMs: 3000,
    });

    vi.advanceTimersByTime(1000);
    detector["checkAllInvoices"]();

    expect(warnHandler).toHaveBeenCalledOnce();
    expect(warnHandler).toHaveBeenCalledWith({
      type: "sla:warn",
      invoiceId: "inv-001",
      level: "warn",
    });
  });

  it("emits sla:critical event after criticalAtMs elapses", () => {
    const criticalHandler = vi.fn();
    detector.on("sla:critical", criticalHandler);

    detector.track("inv-001", {
      warnAtMs: 1000,
      criticalAtMs: 2000,
      deadlineMs: 3000,
    });

    vi.advanceTimersByTime(2000);
    detector["checkAllInvoices"]();

    expect(criticalHandler).toHaveBeenCalledOnce();
    expect(criticalHandler).toHaveBeenCalledWith({
      type: "sla:critical",
      invoiceId: "inv-001",
      level: "critical",
    });
  });

  it("emits sla:breached event after deadlineMs elapses", () => {
    const breachedHandler = vi.fn();
    detector.on("sla:breached", breachedHandler);

    detector.track("inv-001", {
      warnAtMs: 1000,
      criticalAtMs: 2000,
      deadlineMs: 3000,
    });

    vi.advanceTimersByTime(3000);
    detector["checkAllInvoices"]();

    expect(breachedHandler).toHaveBeenCalledOnce();
    expect(breachedHandler).toHaveBeenCalledWith({
      type: "sla:breached",
      invoiceId: "inv-001",
      level: "breached",
    });
  });

  it("emits events in correct order: warn → critical → breached", () => {
    const events: string[] = [];
    detector.on("sla:warn", () => events.push("warn"));
    detector.on("sla:critical", () => events.push("critical"));
    detector.on("sla:breached", () => events.push("breached"));

    detector.track("inv-001", {
      warnAtMs: 1000,
      criticalAtMs: 2000,
      deadlineMs: 3000,
    });

    vi.advanceTimersByTime(1000);
    detector["checkAllInvoices"]();

    vi.advanceTimersByTime(1000);
    detector["checkAllInvoices"]();

    vi.advanceTimersByTime(1000);
    detector["checkAllInvoices"]();

    expect(events).toEqual(["warn", "critical", "breached"]);
  });

  it("emits each event only once per invoice", () => {
    const warnHandler = vi.fn();
    detector.on("sla:warn", warnHandler);

    detector.track("inv-001", {
      warnAtMs: 1000,
      criticalAtMs: 2000,
      deadlineMs: 3000,
    });

    vi.advanceTimersByTime(1000);
    detector["checkAllInvoices"]();
    detector["checkAllInvoices"]();
    detector["checkAllInvoices"]();

    expect(warnHandler).toHaveBeenCalledTimes(1);
  });

  it("untrack() stops further events and removes state", () => {
    const warnHandler = vi.fn();
    detector.on("sla:warn", warnHandler);

    detector.track("inv-001", {
      warnAtMs: 1000,
      criticalAtMs: 2000,
      deadlineMs: 3000,
    });

    detector.untrack("inv-001");

    vi.advanceTimersByTime(1000);
    detector["checkAllInvoices"]();

    expect(warnHandler).not.toHaveBeenCalled();
  });

  it("getStatus() returns ok level before any threshold", () => {
    detector.track("inv-001", {
      warnAtMs: 1000,
      criticalAtMs: 2000,
      deadlineMs: 3000,
    });

    const status = detector.getStatus("inv-001");

    expect(status.level).toBe("ok");
    expect(status.timeUntilNextThresholdMs).toBeGreaterThan(0);
  });

  it("getStatus() returns warn level after warnAtMs", () => {
    detector.track("inv-001", {
      warnAtMs: 1000,
      criticalAtMs: 2000,
      deadlineMs: 3000,
    });

    vi.advanceTimersByTime(1000);

    const status = detector.getStatus("inv-001");

    expect(status.level).toBe("warn");
  });

  it("getStatus() returns critical level after criticalAtMs", () => {
    detector.track("inv-001", {
      warnAtMs: 1000,
      criticalAtMs: 2000,
      deadlineMs: 3000,
    });

    vi.advanceTimersByTime(2000);

    const status = detector.getStatus("inv-001");

    expect(status.level).toBe("critical");
  });

  it("getStatus() returns breached level after deadlineMs", () => {
    detector.track("inv-001", {
      warnAtMs: 1000,
      criticalAtMs: 2000,
      deadlineMs: 3000,
    });

    vi.advanceTimersByTime(3000);

    const status = detector.getStatus("inv-001");

    expect(status.level).toBe("breached");
  });

  it("supports multiple invoices independently", () => {
    const events: string[] = [];
    detector.on("sla:warn", (e: SlaBreachEvent) =>
      events.push(`${e.invoiceId}:warn`)
    );

    detector.track("inv-001", {
      warnAtMs: 1000,
      criticalAtMs: 2000,
      deadlineMs: 3000,
    });

    detector.track("inv-002", {
      warnAtMs: 500,
      criticalAtMs: 1500,
      deadlineMs: 2500,
    });

    vi.advanceTimersByTime(1000);
    detector["checkAllInvoices"]();

    expect(events).toContain("inv-002:warn");
    expect(events).toContain("inv-001:warn");
  });

  it("applies global config as defaults", () => {
    const detectorWithGlobal = new SlaBreachDetector({
      warnAtMs: 500,
      criticalAtMs: 1000,
      deadlineMs: 1500,
    });

    const warnHandler = vi.fn();
    detectorWithGlobal.on("sla:warn", warnHandler);

    detectorWithGlobal.track("inv-001");

    vi.advanceTimersByTime(500);
    detectorWithGlobal["checkAllInvoices"]();

    expect(warnHandler).toHaveBeenCalledOnce();

    detectorWithGlobal.destroy();
  });

  it("invoice config overrides global config", () => {
    const detectorWithGlobal = new SlaBreachDetector({
      warnAtMs: 1000,
      criticalAtMs: 2000,
      deadlineMs: 3000,
    });

    const warnHandler = vi.fn();
    detectorWithGlobal.on("sla:warn", warnHandler);

    detectorWithGlobal.track("inv-001", {
      warnAtMs: 500,
    });

    vi.advanceTimersByTime(500);
    detectorWithGlobal["checkAllInvoices"]();

    expect(warnHandler).toHaveBeenCalledOnce();

    detectorWithGlobal.destroy();
  });
});
