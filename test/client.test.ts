import { describe, it, expect } from "vitest";
import {
  formatAmount,
  parseAmount,
  isValidAddress,
  deadlineFromDays,
  isExpired,
  truncateAddress,
} from "../src/utils.js";

describe("formatAmount", () => {
  it("formats whole units", () => {
    expect(formatAmount(10_000_000n)).toBe("1.0000000");
  });

  it("formats fractional units", () => {
    expect(formatAmount(15_000_000n)).toBe("1.5000000");
  });

  it("formats zero", () => {
    expect(formatAmount(0n)).toBe("0.0000000");
  });

  it("formats large amounts", () => {
    expect(formatAmount(1_000_000_000n)).toBe("100.0000000");
  });
});

describe("parseAmount", () => {
  it("parses whole units", () => {
    expect(parseAmount("1")).toBe(10_000_000n);
  });

  it("parses fractional units", () => {
    expect(parseAmount("1.5")).toBe(15_000_000n);
  });

  it("parses zero", () => {
    expect(parseAmount("0")).toBe(0n);
  });

  it("round-trips with formatAmount", () => {
    const stroops = 123_456_789n;
    expect(parseAmount(formatAmount(stroops))).toBe(stroops);
  });
});

describe("isValidAddress", () => {
  it("accepts valid G address", () => {
    expect(
      isValidAddress("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN")
    ).toBe(true);
  });

  it("rejects short address", () => {
    expect(isValidAddress("GABC")).toBe(false);
  });

  it("rejects non-G prefix", () => {
    expect(
      isValidAddress("SAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN")
    ).toBe(false);
  });
});

describe("deadlineFromDays", () => {
  it("returns a future timestamp", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(deadlineFromDays(7)).toBeGreaterThan(now);
  });

  it("is approximately 7 days ahead", () => {
    const now = Math.floor(Date.now() / 1000);
    const deadline = deadlineFromDays(7);
    expect(deadline - now).toBeCloseTo(7 * 86_400, -2);
  });
});

describe("isExpired", () => {
  it("returns true for past timestamp", () => {
    expect(isExpired(1_000_000)).toBe(true);
  });

  it("returns false for future timestamp", () => {
    expect(isExpired(Math.floor(Date.now() / 1000) + 10_000)).toBe(false);
  });
});

describe("truncateAddress", () => {
  it("truncates long address", () => {
    const addr = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
    expect(truncateAddress(addr)).toBe("GAAZ...CCWN");
  });

  it("respects custom chars param", () => {
    const addr = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
    const result = truncateAddress(addr, 6);
    expect(result).toBe("GAAZI4...KOCCWN");
  });
});

describe("checkRPCHealth", () => {
  it("returns health status with ok status", async () => {
    const { checkRPCHealth } = await import("../src/health.js");
    const mockServer = {
      getLatestLedger: async () => ({ sequence: 12345 }),
    };
    const health = await checkRPCHealth(mockServer as any);
    expect(health.status).toBe("ok");
    expect(health.blockHeight).toBe(12345);
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    expect(health.timestamp).toBeGreaterThan(0);
  });

  it("returns degraded status when latency > 2000ms", async () => {
    const { checkRPCHealth } = await import("../src/health.js");
    const mockServer = {
      getLatestLedger: async () => {
        await new Promise((r) => setTimeout(r, 2100));
        return { sequence: 12345 };
      },
    };
    const health = await checkRPCHealth(mockServer as any);
    expect(health.status).toBe("degraded");
    expect(health.latencyMs).toBeGreaterThan(2000);
  });

  it("returns down status when RPC throws", async () => {
    const { checkRPCHealth } = await import("../src/health.js");
    const mockServer = {
      getLatestLedger: async () => {
        throw new Error("Connection failed");
      },
    };
    const health = await checkRPCHealth(mockServer as any);
    expect(health.status).toBe("down");
    expect(health.blockHeight).toBe(0);
  });
});
