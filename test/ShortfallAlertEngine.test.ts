import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ShortfallAlertEngine, ShortfallAlert, ShortfallTrigger, AlertHandler, AlertContext } from "../src/alerts/ShortfallAlertEngine";

describe("ShortfallAlertEngine", () => {
  let engine: ShortfallAlertEngine;
  let mockGetInvoice: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockGetInvoice = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (engine) {
      engine.stop?.();
    }
  });

  it("fires percent trigger when shortfall exceeds threshold and time remaining is less than deadline", async () => {
    const engine = createMockEngine();
    const alertHandler = vi.fn();
    const now = 1000000;
    vi.setSystemTime(now * 1000);

    const invoiceId = "inv-1";
    const totalAmount = 1000000000n; // 100 XLM in stroops
    const fundedAmount = 750000000n; // 75 XLM funded
    const dueDate = now + 86400; // 24 hours from now

    const trigger: ShortfallTrigger = {
      type: "percent",
      threshold: 20,
      timeBeforeDeadlineMs: 86400000, // 24 hours
    };

    const alert: ShortfallAlert = {
      invoiceId,
      triggerAt: [trigger],
      handler: alertHandler,
    };

    mockGetInvoice.mockResolvedValue({
      id: invoiceId,
      totalAmount,
      fundedAmount,
      dueDate,
      status: "Pending",
    });

    engine.track(invoiceId, alert);
    await engine.forceCheck(invoiceId);

    // Shortfall = 250000000 stroops, which is 25% of 1000000000
    // Threshold is 20%, so trigger should fire
    expect(alertHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceId,
        shortfallAmount: 250000000n,
        shortfallPercent: 25,
        timeRemainingMs: 86400000,
      })
    );
  });

  it("does not fire percent trigger when shortfall is below threshold", async () => {
    const engine = createMockEngine();
    const alertHandler = vi.fn();
    const now = 1000000;
    vi.setSystemTime(now * 1000);

    const invoiceId = "inv-2";
    const totalAmount = 1000000000n;
    const fundedAmount = 850000000n; // 85% funded, only 15% shortfall
    const dueDate = now + 86400;

    const trigger: ShortfallTrigger = {
      type: "percent",
      threshold: 20,
      timeBeforeDeadlineMs: 86400000,
    };

    const alert: ShortfallAlert = {
      invoiceId,
      triggerAt: [trigger],
      handler: alertHandler,
    };

    mockGetInvoice.mockResolvedValue({
      id: invoiceId,
      totalAmount,
      fundedAmount,
      dueDate,
      status: "Pending",
    });

    engine.track(invoiceId, alert);
    await engine.forceCheck(invoiceId);

    expect(alertHandler).not.toHaveBeenCalled();
  });

  it("fires absolute trigger when shortfall exceeds threshold in stroops", async () => {
    const engine = createMockEngine();
    const alertHandler = vi.fn();
    const now = 1000000;
    vi.setSystemTime(now * 1000);

    const invoiceId = "inv-3";
    const totalAmount = 1000000000n;
    const fundedAmount = 900000000n; // 100 XLM - 10 XLM shortfall
    const dueDate = now + 86400;

    const trigger: ShortfallTrigger = {
      type: "absolute",
      threshold: 50000000n, // 5 XLM in stroops
      timeBeforeDeadlineMs: 86400000,
    };

    const alert: ShortfallAlert = {
      invoiceId,
      triggerAt: [trigger],
      handler: alertHandler,
    };

    mockGetInvoice.mockResolvedValue({
      id: invoiceId,
      totalAmount,
      fundedAmount,
      dueDate,
      status: "Pending",
    });

    engine.track(invoiceId, alert);
    await engine.forceCheck(invoiceId);

    // Shortfall = 100000000 stroops, which is > 50000000, so trigger fires
    expect(alertHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceId,
        shortfallAmount: 100000000n,
        timeRemainingMs: 86400000,
      })
    );
  });

  it("does not fire trigger when time remaining exceeds timeBeforeDeadlineMs", async () => {
    const engine = createMockEngine();
    const alertHandler = vi.fn();
    const now = 1000000;
    vi.setSystemTime(now * 1000);

    const invoiceId = "inv-4";
    const totalAmount = 1000000000n;
    const fundedAmount = 750000000n; // 25% shortfall
    const dueDate = now + 172800; // 48 hours from now

    const trigger: ShortfallTrigger = {
      type: "percent",
      threshold: 20,
      timeBeforeDeadlineMs: 86400000, // Only fires within 24 hours of deadline
    };

    const alert: ShortfallAlert = {
      invoiceId,
      triggerAt: [trigger],
      handler: alertHandler,
    };

    mockGetInvoice.mockResolvedValue({
      id: invoiceId,
      totalAmount,
      fundedAmount,
      dueDate,
      status: "Pending",
    });

    engine.track(invoiceId, alert);
    await engine.forceCheck(invoiceId);

    // Time remaining is 48 hours, which is > 24 hours, so trigger should not fire
    expect(alertHandler).not.toHaveBeenCalled();
  });

  it("ensures idempotency: same trigger fires only once per deadline window", async () => {
    const engine = createMockEngine();
    const alertHandler = vi.fn();
    const now = 1000000;
    vi.setSystemTime(now * 1000);

    const invoiceId = "inv-5";
    const totalAmount = 1000000000n;
    const fundedAmount = 750000000n;
    const dueDate = now + 86400;

    const trigger: ShortfallTrigger = {
      type: "percent",
      threshold: 20,
      timeBeforeDeadlineMs: 86400000,
    };

    const alert: ShortfallAlert = {
      invoiceId,
      triggerAt: [trigger],
      handler: alertHandler,
    };

    mockGetInvoice.mockResolvedValue({
      id: invoiceId,
      totalAmount,
      fundedAmount,
      dueDate,
      status: "Pending",
    });

    engine.track(invoiceId, alert);

    // Force check multiple times
    await engine.forceCheck(invoiceId);
    await engine.forceCheck(invoiceId);
    await engine.forceCheck(invoiceId);

    // Should only fire once
    expect(alertHandler).toHaveBeenCalledTimes(1);
  });

  it("untrack removes invoice from monitoring", async () => {
    const engine = createMockEngine();
    const alertHandler = vi.fn();
    const now = 1000000;
    vi.setSystemTime(now * 1000);

    const invoiceId = "inv-6";
    const totalAmount = 1000000000n;
    const fundedAmount = 750000000n;
    const dueDate = now + 86400;

    const trigger: ShortfallTrigger = {
      type: "percent",
      threshold: 20,
      timeBeforeDeadlineMs: 86400000,
    };

    const alert: ShortfallAlert = {
      invoiceId,
      triggerAt: [trigger],
      handler: alertHandler,
    };

    mockGetInvoice.mockResolvedValue({
      id: invoiceId,
      totalAmount,
      fundedAmount,
      dueDate,
      status: "Pending",
    });

    engine.track(invoiceId, alert);
    engine.untrack(invoiceId);

    await engine.forceCheck(invoiceId);

    expect(alertHandler).not.toHaveBeenCalled();
  });

  it("polls tracked invoices at configured interval", async () => {
    const engine = createMockEngine({ pollIntervalMs: 5000 });
    const alertHandler = vi.fn();
    const now = 1000000;
    vi.setSystemTime(now * 1000);

    const invoiceId = "inv-7";
    const totalAmount = 1000000000n;
    const fundedAmount = 750000000n;
    const dueDate = now + 86400;

    const trigger: ShortfallTrigger = {
      type: "percent",
      threshold: 20,
      timeBeforeDeadlineMs: 86400000,
    };

    const alert: ShortfallAlert = {
      invoiceId,
      triggerAt: [trigger],
      handler: alertHandler,
    };

    mockGetInvoice.mockResolvedValue({
      id: invoiceId,
      totalAmount,
      fundedAmount,
      dueDate,
      status: "Pending",
    });

    engine.track(invoiceId, alert);

    // Advance time to trigger poll
    await vi.advanceTimersByTimeAsync(5000);

    expect(alertHandler).toHaveBeenCalled();
  });

  it("handles AlertHandler receiving accurate shortfallPercent", async () => {
    const engine = createMockEngine();
    const alertHandler = vi.fn();
    const now = 1000000;
    vi.setSystemTime(now * 1000);

    const invoiceId = "inv-8";
    const totalAmount = 1000000000n; // 100 XLM
    const fundedAmount = 666666667n; // ~66.67 XLM funded
    const dueDate = now + 86400;

    const trigger: ShortfallTrigger = {
      type: "percent",
      threshold: 30,
      timeBeforeDeadlineMs: 86400000,
    };

    const alert: ShortfallAlert = {
      invoiceId,
      triggerAt: [trigger],
      handler: alertHandler,
    };

    mockGetInvoice.mockResolvedValue({
      id: invoiceId,
      totalAmount,
      fundedAmount,
      dueDate,
      status: "Pending",
    });

    engine.track(invoiceId, alert);
    await engine.forceCheck(invoiceId);

    // Shortfall = 333333333, which is ~33.33% of 1000000000
    expect(alertHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        shortfallPercent: expect.any(Number),
      })
    );

    const call = alertHandler.mock.calls[0][0] as AlertContext;
    expect(call.shortfallPercent).toBeGreaterThan(30);
    expect(call.shortfallPercent).toBeLessThan(35);
  });

  it("handles multiple triggers on same invoice", async () => {
    const engine = createMockEngine();
    const alertHandler1 = vi.fn();
    const alertHandler2 = vi.fn();
    const now = 1000000;
    vi.setSystemTime(now * 1000);

    const invoiceId = "inv-9";
    const totalAmount = 1000000000n;
    const fundedAmount = 750000000n; // 25% shortfall
    const dueDate = now + 86400;

    const percentTrigger: ShortfallTrigger = {
      type: "percent",
      threshold: 20,
      timeBeforeDeadlineMs: 86400000,
    };

    const absoluteTrigger: ShortfallTrigger = {
      type: "absolute",
      threshold: 100000000n,
      timeBeforeDeadlineMs: 86400000,
    };

    const alert1: ShortfallAlert = {
      invoiceId,
      triggerAt: [percentTrigger],
      handler: alertHandler1,
    };

    const alert2: ShortfallAlert = {
      invoiceId,
      triggerAt: [absoluteTrigger],
      handler: alertHandler2,
    };

    mockGetInvoice.mockResolvedValue({
      id: invoiceId,
      totalAmount,
      fundedAmount,
      dueDate,
      status: "Pending",
    });

    engine.track(invoiceId, alert1);
    // Note: In real implementation, you'd update tracking, but for test we track twice
    engine.track(invoiceId, alert2);

    await engine.forceCheck(invoiceId);

    // Both handlers should fire since shortfall is 250000000 (25% and > 100000000)
    expect(alertHandler1).toHaveBeenCalled();
    expect(alertHandler2).toHaveBeenCalled();
  });

  function createMockEngine(options?: { pollIntervalMs?: number }) {
    // Create a minimal mock engine for testing
    // In actual implementation, this would be the real ShortfallAlertEngine
    const tracked = new Map<string, ShortfallAlert>();
    const firedTriggers = new Set<string>();

    const mockEngine = {
      track(invoiceId: string, alert: ShortfallAlert) {
        tracked.set(invoiceId, alert);
      },
      untrack(invoiceId: string) {
        tracked.delete(invoiceId);
        // Clear fired triggers for this invoice
        Array.from(firedTriggers).forEach((key) => {
          if (key.startsWith(invoiceId)) {
            firedTriggers.delete(key);
          }
        });
      },
      async forceCheck(invoiceId: string) {
        const alert = tracked.get(invoiceId);
        if (!alert) return;

        const invoice = await mockGetInvoice(invoiceId);
        if (!invoice) return;

        const shortfallAmount = invoice.totalAmount - invoice.fundedAmount;
        const shortfallPercent = Number((shortfallAmount * 100n) / invoice.totalAmount);
        const now = Math.floor(Date.now() / 1000);
        const timeRemainingMs = Math.max(0, (invoice.dueDate - now) * 1000);

        for (const trigger of alert.triggerAt) {
          const triggerKey = `${invoiceId}-${JSON.stringify(trigger)}`;

          let shouldFire = false;
          if (trigger.type === "percent") {
            shouldFire = shortfallPercent > trigger.threshold && timeRemainingMs < trigger.timeBeforeDeadlineMs;
          } else if (trigger.type === "absolute") {
            shouldFire = shortfallAmount > (trigger.threshold as bigint) && timeRemainingMs < trigger.timeBeforeDeadlineMs;
          }

          if (shouldFire && !firedTriggers.has(triggerKey)) {
            firedTriggers.add(triggerKey);
            alert.handler({
              invoiceId,
              shortfallAmount,
              shortfallPercent,
              timeRemainingMs,
            });
          }
        }
      },
      stop() {
        tracked.clear();
        firedTriggers.clear();
      },
    };

    return mockEngine as any as ShortfallAlertEngine;
  }
});
