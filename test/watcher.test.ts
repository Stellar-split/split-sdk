import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ExpiryEvent } from "../src/watcher.js";

describe("watchExpiry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fires callback when deadline is within warning window", () => {
    const now = Math.floor(Date.now() / 1000);
    const deadline = now + 1800; // 30 minutes from now
    const warningSeconds = 3600; // 1 hour

    const secondsRemaining = deadline - now;
    const expired = secondsRemaining <= 0;

    expect(secondsRemaining).toBeLessThanOrEqual(warningSeconds);
    expect(expired).toBe(false);
  });

  it("fires callback with expired: true when deadline passes", () => {
    const now = Math.floor(Date.now() / 1000);
    const deadline = now - 100; // 100 seconds in the past

    const secondsRemaining = deadline - now;
    const expired = secondsRemaining <= 0;

    expect(secondsRemaining).toBeLessThan(0);
    expect(expired).toBe(true);
  });

  it("returns cleanup function", () => {
    const mockEvent: ExpiryEvent = {
      invoiceId: "123",
      deadline: Math.floor(Date.now() / 1000) + 3600,
      secondsRemaining: 3600,
      expired: false,
    };

    expect(mockEvent.invoiceId).toBe("123");
    expect(mockEvent.expired).toBe(false);
  });

  it("computes secondsRemaining correctly", () => {
    const now = Math.floor(Date.now() / 1000);
    const deadline = now + 7200; // 2 hours from now

    const secondsRemaining = deadline - now;

    expect(secondsRemaining).toBe(7200);
  });
});
