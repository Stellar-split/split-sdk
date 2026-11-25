import { describe, expect, it, vi } from "vitest";
import { PaymentFlowExhaustedError, PaymentFlowRetry, type PaymentProvider } from "../paymentFlowRetry";

const noSleep = () => Promise.resolve();

function provider(name: string, outcomes: Array<Error | string>): PaymentProvider<string, string> {
  const queue = [...outcomes];
  return {
    name,
    execute: vi.fn(async () => {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next ?? `${name}-ok`;
    }),
  };
}

describe("PaymentFlowRetry", () => {
  it("returns the result on first success without retrying", async () => {
    const primary = provider("primary", ["tx-1"]);
    const flow = new PaymentFlowRetry([primary], { sleep: noSleep });

    const outcome = await flow.execute("payment");

    expect(outcome.result).toBe("tx-1");
    expect(outcome.provider).toBe("primary");
    expect(outcome.attempts).toHaveLength(1);
    expect(primary.execute).toHaveBeenCalledTimes(1);
  });

  it("retries transient failures until success", async () => {
    const primary = provider("primary", [new Error("network timeout"), new Error("503 unavailable"), "tx-3"]);
    const flow = new PaymentFlowRetry([primary], { sleep: noSleep });

    const outcome = await flow.execute("payment");

    expect(outcome.result).toBe("tx-3");
    expect(primary.execute).toHaveBeenCalledTimes(3);
  });

  it("waits with exponential backoff between retries", async () => {
    const sleep = vi.fn(noSleep);
    const primary = provider("primary", [new Error("timeout"), new Error("timeout"), "tx"]);
    const flow = new PaymentFlowRetry([primary], { baseDelayMs: 100, maxAttempts: 3, sleep });

    await flow.execute("payment");

    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200]);
  });

  it("falls back to the next provider after exhausting retries", async () => {
    const primary = provider("primary", [new Error("timeout"), new Error("timeout")]);
    const backup = provider("backup", ["backup-tx"]);
    const flow = new PaymentFlowRetry([primary, backup], { maxAttempts: 2, sleep: noSleep });

    const outcome = await flow.execute("payment");

    expect(outcome.provider).toBe("backup");
    expect(outcome.result).toBe("backup-tx");
    expect(primary.execute).toHaveBeenCalledTimes(2);
  });

  it("skips straight to fallback on non-transient errors", async () => {
    const primary = provider("primary", [new Error("insufficient balance")]);
    const backup = provider("backup", ["backup-tx"]);
    const flow = new PaymentFlowRetry([primary, backup], { maxAttempts: 3, sleep: noSleep });

    const outcome = await flow.execute("payment");

    expect(primary.execute).toHaveBeenCalledTimes(1);
    expect(outcome.attempts[0]).toMatchObject({ provider: "primary", success: false, transient: false });
  });

  it("tracks every attempt with provider, attempt number and delay", async () => {
    const onAttempt = vi.fn();
    const primary = provider("primary", [new Error("timeout"), "tx"]);
    const flow = new PaymentFlowRetry([primary], { baseDelayMs: 50, sleep: noSleep, onAttempt });

    await flow.execute("payment");

    expect(onAttempt).toHaveBeenCalledTimes(2);
    expect(flow.getAttempts()).toEqual([
      expect.objectContaining({ provider: "primary", attempt: 1, success: false, transient: true, delayMs: 50 }),
      expect.objectContaining({ provider: "primary", attempt: 2, success: true, delayMs: 0 }),
    ]);
  });

  it("throws PaymentFlowExhaustedError when all providers fail", async () => {
    const primary = provider("primary", [new Error("timeout"), new Error("timeout")]);
    const backup = provider("backup", [new Error("rejected")]);
    const flow = new PaymentFlowRetry([primary, backup], { maxAttempts: 2, sleep: noSleep });

    const error = await flow.execute("payment").catch((err) => err);

    expect(error).toBeInstanceOf(PaymentFlowExhaustedError);
    expect((error as PaymentFlowExhaustedError).attempts).toHaveLength(3);
  });
});
