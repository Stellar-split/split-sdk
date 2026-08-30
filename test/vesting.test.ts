import { describe, it, expect } from "vitest";
import { vestedAt } from "../src/vesting.js";
import type { VestingOptions } from "../src/vesting.js";

const START = 1_000_000; // arbitrary unix timestamp
const DURATION = 1_000;  // 1000 seconds total vesting
const TOTAL = 1_000_000n; // 1M stroops

describe("vestedAt — no cliff (default)", () => {
  const opts: VestingOptions = { startTime: START, duration: DURATION, totalAmount: TOTAL };

  it("returns 0n before vesting starts", () => {
    expect(vestedAt(START - 1, opts)).toBe(0n);
  });

  it("returns 0n at exactly startTime", () => {
    expect(vestedAt(START, opts)).toBe(0n);
  });

  it("returns proportional amount mid-vesting", () => {
    // 500s elapsed of 1000s = 50%
    expect(vestedAt(START + 500, opts)).toBe(500_000n);
  });

  it("returns totalAmount at or after full duration", () => {
    expect(vestedAt(START + DURATION, opts)).toBe(TOTAL);
    expect(vestedAt(START + DURATION + 9999, opts)).toBe(TOTAL);
  });
});

describe("vestedAt — with cliffDuration", () => {
  const opts: VestingOptions = {
    startTime: START,
    duration: DURATION,
    totalAmount: TOTAL,
    cliffDuration: 200, // 200s cliff
  };

  it("returns 0n before cliff elapses", () => {
    expect(vestedAt(START + 0, opts)).toBe(0n);
    expect(vestedAt(START + 199, opts)).toBe(0n);
  });

  it("returns 0n at exactly the cliff boundary", () => {
    // elapsed === cliffDuration means 0 post-cliff elapsed → 0 vested
    expect(vestedAt(START + 200, opts)).toBe(0n);
  });

  it("returns proportional amount after cliff", () => {
    // elapsed=600 → post-cliff elapsed=400; vesting window=800s
    // 400/800 * 1_000_000 = 500_000
    expect(vestedAt(START + 600, opts)).toBe(500_000n);
  });

  it("returns totalAmount at or after full duration", () => {
    expect(vestedAt(START + DURATION, opts)).toBe(TOTAL);
    expect(vestedAt(START + DURATION + 5000, opts)).toBe(TOTAL);
  });

  it("explicit cliffDuration=0 behaves identically to no cliff", () => {
    const noCliff: VestingOptions = { ...opts, cliffDuration: 0 };
    expect(vestedAt(START + 500, noCliff)).toBe(500_000n);
  });
});

describe("vestedAt — return type is bigint", () => {
  it("always returns bigint", () => {
    const opts: VestingOptions = { startTime: 0, duration: 100, totalAmount: 100n };
    expect(typeof vestedAt(50, opts)).toBe("bigint");
    expect(typeof vestedAt(0, opts)).toBe("bigint");
    expect(typeof vestedAt(100, opts)).toBe("bigint");
  });
});
