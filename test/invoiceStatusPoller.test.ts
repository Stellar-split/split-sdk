import { describe, it, expect, vi, afterEach } from "vitest";
import { InvoiceStatusPoller } from "../src/poller.js";

describe("InvoiceStatusPoller", () => {
  afterEach(() => {
    InvoiceStatusPoller.stopAll();
  });

  it("accepts an invoice ID and starts polling", () => {
    const poller = new InvoiceStatusPoller({
      invoiceId: "42",
      pollIntervalMs: 100,
    });
    expect(poller.status).toBe("Pending");
    expect(poller.isStopped).toBe(false);
    poller.stop();
  });

  it("emits invoiceStatusChanged event on status transition", async () => {
    let statusChanges: string[] = [];
    const statuses = ["Pending", "Released"];

    const poller = new InvoiceStatusPoller(
      {
        invoiceId: "42",
        pollIntervalMs: 50,
      },
      async (_id: string) => {
        // Each poll advances to the next status
        const idx = poller.attempts;
        return statuses[idx] ?? "Released";
      },
    );

    poller.on("invoiceStatusChanged", (event) => {
      statusChanges.push(event.current);
    });

    poller.start();

    // Wait for a couple poll cycles
    await vi.waitFor(
      () => {
        expect(statusChanges.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 1000 },
    );

    expect(statusChanges).toContain("Released");
  });

  it("stops polling automatically on terminal state", async () => {
    const poller = new InvoiceStatusPoller(
      {
        invoiceId: "terminal-test-2",
        pollIntervalMs: 500,
        maxAttempts: 5,
      },
      async () => "Released",
    );

    poller.start();

    // The first poll fires immediately, so it should stop right away
    await vi.waitFor(
      () => poller.isStopped === true,
      { timeout: 2000, interval: 50 },
    );

    expect(poller.isStopped).toBe(true);
    expect(poller.status).toBe("Released");
  });

  it("calls onSettled callback on terminal state", async () => {
    let settledStatus: string | undefined;

    const poller = new InvoiceStatusPoller(
      {
        invoiceId: "settled-test",
        pollIntervalMs: 50,
        maxAttempts: 5,
        onSettled: (status) => {
          settledStatus = status;
        },
      },
      async () => "Cancelled",
    );

    poller.start();

    await vi.waitFor(
      () => settledStatus !== undefined,
      { timeout: 2000 },
    );

    expect(settledStatus).toBe("Cancelled");
  });

  it("coalesces concurrent polls for the same invoice", async () => {
    // Create a poller, then try to create another for the same invoice
    const poller1 = new InvoiceStatusPoller(
      { invoiceId: "same", pollIntervalMs: 50 },
      async () => "Pending",
    );

    // Creating a second poller replaces the first
    const poller2 = new InvoiceStatusPoller(
      { invoiceId: "same", pollIntervalMs: 50 },
      async () => "Released",
    );

    expect(poller1.isStopped).toBe(true); // First one stopped
    expect(poller2.isStopped).toBe(false);

    poller2.stop();
  });

  it("stopAll cancels every active poller", () => {
    const p1 = new InvoiceStatusPoller(
      { invoiceId: "a", pollIntervalMs: 100 },
      async () => "Pending",
    );
    const p2 = new InvoiceStatusPoller(
      { invoiceId: "b", pollIntervalMs: 100 },
      async () => "Pending",
    );

    p1.start();
    p2.start();

    InvoiceStatusPoller.stopAll();

    expect(p1.isStopped).toBe(true);
    expect(p2.isStopped).toBe(true);
  });

  it("respects maxAttempts limit", () => {
    return new Promise<void>((resolve) => {
      const poller = new InvoiceStatusPoller(
        {
          invoiceId: "max-attempts-test-2",
          pollIntervalMs: 20,
          maxAttempts: 3,
        },
        async () => "Pending",
      );

      poller.start();

      // Check every 30ms for up to 2000ms
      const checkInterval = setInterval(() => {
        if (poller.isStopped) {
          clearInterval(checkInterval);
          expect(poller.attempts).toBeLessThanOrEqual(3);
          expect(poller.isStopped).toBe(true);
          resolve();
        }
      }, 30);

      setTimeout(() => {
        clearInterval(checkInterval);
        // Last resort: check state
        expect(poller.isStopped).toBe(true);
        resolve();
      }, 2000);
    });
  });

  it("getActivePoller returns existing poller", () => {
    const poller = new InvoiceStatusPoller(
      { invoiceId: "find-me" },
    );

    const found = InvoiceStatusPoller.getActivePoller("find-me");
    expect(found).toBe(poller);

    poller.stop();
  });
});
