import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  reconcileChannel,
  registerChannelStateFetcher,
} from "../src/channelReconciler.js";
import type { ChannelState } from "../src/channelReconciler.js";

const INVOICE_ID = "42";
const PAYER = "GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ012345678901234";

describe("reconcileChannel", () => {
  beforeEach(() => {
    // Reset global fetcher between tests
    registerChannelStateFetcher(async () => ({ deposited: 0n, balance: 0n }));
  });

  it("reports in-sync when on-chain balance matches local payment history", async () => {
    // Deposited 1000, paid 300 + 200 locally → expected balance = 500
    const state: ChannelState = { deposited: 1000n, balance: 500n };
    const fetcher = vi.fn().mockResolvedValue(state);

    const result = await reconcileChannel(INVOICE_ID, PAYER, [300n, 200n], fetcher);

    expect(result.inSync).toBe(true);
    expect(result.onChainBalance).toBe(500n);
    expect(result.expectedBalance).toBe(500n);
    expect(result.delta).toBe(0n);
    expect(fetcher).toHaveBeenCalledWith(INVOICE_ID, PAYER);
  });

  it("detects drift when on-chain balance differs from expected", async () => {
    // Deposited 1000, paid 300 locally → expected balance = 700
    // But chain shows only 600 → drift of -100
    const state: ChannelState = { deposited: 1000n, balance: 600n };
    const fetcher = vi.fn().mockResolvedValue(state);

    const result = await reconcileChannel(INVOICE_ID, PAYER, [300n], fetcher);

    expect(result.inSync).toBe(false);
    expect(result.onChainBalance).toBe(600n);
    expect(result.expectedBalance).toBe(700n);
    expect(result.delta).toBe(-100n);
  });

  it("handles zero local payments (channel opened but no payments yet)", async () => {
    const state: ChannelState = { deposited: 500n, balance: 500n };
    const fetcher = vi.fn().mockResolvedValue(state);

    const result = await reconcileChannel(INVOICE_ID, PAYER, [], fetcher);

    expect(result.inSync).toBe(true);
    expect(result.expectedBalance).toBe(500n);
  });

  it("uses the registered global fetcher when no per-call fetcher is provided", async () => {
    const state: ChannelState = { deposited: 800n, balance: 300n };
    const globalFetcher = vi.fn().mockResolvedValue(state);
    registerChannelStateFetcher(globalFetcher);

    const result = await reconcileChannel(INVOICE_ID, PAYER, [500n]);

    expect(result.inSync).toBe(true);
    expect(globalFetcher).toHaveBeenCalledWith(INVOICE_ID, PAYER);
  });

  it("throws when no fetcher is registered and none is passed", async () => {
    registerChannelStateFetcher(null);
    await expect(
      reconcileChannel(INVOICE_ID, PAYER, [100n])
    ).rejects.toThrow("No channel state fetcher registered");
  });
});
