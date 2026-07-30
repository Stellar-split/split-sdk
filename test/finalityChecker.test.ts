import { describe, expect, it, vi } from "vitest";
import { FinalityTimeoutError } from "../src/errors.js";
import { FinalityChecker, type FinalityServerLike } from "../src/finalityChecker.js";

function server(txLedger: number, ledgers: number[], successful = true): FinalityServerLike {
  let ledgerCall = 0;
  return {
    transactions: () => ({
      transaction: () => ({
        call: async () => ({ ledger: txLedger, successful }),
      }),
    }),
    ledgers: () => ({
      order: () => ({
        limit: () => ({
          call: async () => ({ records: [{ sequence: ledgers[Math.min(ledgerCall++, ledgers.length - 1)]! }] }),
        }),
      }),
    }),
  };
}

describe("FinalityChecker", () => {
  it("counts confirmations and finalizes only after threshold", async () => {
    const checker = new FinalityChecker(server(10, [11, 12]), {
      minConfirmations: 2,
      pollIntervalMs: 1,
      maxWaitMs: 50,
    });

    await expect(checker.check("hash")).resolves.toEqual({
      finalized: true,
      confirmations: 2,
      ledgerSequence: 10,
    });
  });

  it("throws on timeout", async () => {
    vi.useFakeTimers();
    const checker = new FinalityChecker(server(10, [10], true), {
      minConfirmations: 2,
      pollIntervalMs: 10,
      maxWaitMs: 20,
    });
    const promise = checker.check("hash");
    const assertion = expect(promise).rejects.toBeInstanceOf(FinalityTimeoutError);

    await vi.advanceTimersByTimeAsync(30);
    await assertion;
    vi.useRealTimers();
  });
});
