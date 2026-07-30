import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Sep24Handler, resolveAnchorTransferServer } from "../src/sep/sep24Handler.js";
import type { Sep24TransactionRecord } from "../src/types.js";

// Mock StellarTomlResolver
vi.mock("@stellar/stellar-sdk", () => ({
  StellarTomlResolver: {
    resolve: vi.fn(),
  },
}));

import { StellarTomlResolver } from "@stellar/stellar-sdk";

describe("Sep24Handler", () => {
  let handler: Sep24Handler;

  beforeEach(() => {
    handler = new Sep24Handler();
    vi.useFakeTimers();
  });

  afterEach(() => {
    handler.destroy();
    vi.useRealTimers();
  });

  const mockInitResponse = {
    id: "txn-abc123",
    url: "https://anchor.example.com/interactive/abc123",
    interactive_url: "https://anchor.example.com/interactive/abc123",
  };

  const mockStatusResponse = (status: string) => ({
    transaction: {
      id: "txn-abc123",
      status,
      stellar_transaction_id: null,
    },
  });

  function mockFetch(responses: Array<{ status: number; body: unknown }>) {
    let callIndex = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      const resp = responses[callIndex++ % responses.length]!;
      return {
        ok: resp.status < 400,
        status: resp.status,
        json: async () => resp.body,
        text: async () => JSON.stringify(resp.body),
      };
    });
  }

  it("throws when SEP-24 initiation fails", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "Bad Request",
    });

    await expect(
      handler.init({
        anchorUrl: "https://anchor.example.com",
        jwt: "test-jwt",
        kind: "deposit",
        assetCode: "USDC",
        assetIssuer: "G...ISSUER",
        amount: 100_0000000n,
        account: "G...USER",
        pollIntervalMs: 100,
      }),
    ).rejects.toThrow("SEP-24 initiation failed");
  });

  it("emits sep24StatusChanged events as status progresses", async () => {
    const events: Sep24TransactionRecord[] = [];
    handler.on("sep24StatusChanged", (event) => {
      events.push(event.transaction);
    });

    mockFetch([
      { status: 200, body: mockInitResponse },
      { status: 200, body: mockStatusResponse("pending_user_transfer_start") },
      { status: 200, body: mockStatusResponse("pending_anchor") },
      { status: 200, body: mockStatusResponse("completed") },
    ]);

    const txn = await handler.init({
      anchorUrl: "https://anchor.example.com",
      jwt: "test-jwt",
      kind: "deposit",
      assetCode: "USDC",
      assetIssuer: "G...ISSUER",
      amount: 100_0000000n,
      account: "G...USER",
      pollIntervalMs: 100,
    });

    expect(txn.status).toBe("incomplete");
    expect(txn.id).toBe("txn-abc123");
    expect(txn.interactiveUrl).toBe("https://anchor.example.com/interactive/abc123");

    // Advance timers to trigger polls
    await vi.advanceTimersByTimeAsync(200);
    expect(events.length).toBeGreaterThanOrEqual(1);

    await vi.advanceTimersByTimeAsync(200);

    // On completed, polling should stop
    const finalTxn = handler.getTransaction();
    expect(finalTxn?.status).toBe("completed");

    // Should stop polling after completed
    await vi.advanceTimersByTimeAsync(500);
    // No more events after terminal status
    const countAfterCompleted = events.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(events.length).toBe(countAfterCompleted);
  });

  it("getTransaction returns null before init", () => {
    expect(handler.getTransaction()).toBeNull();
  });

  it("getTransaction returns the current record after init", async () => {
    mockFetch([
      { status: 200, body: mockInitResponse },
      { status: 200, body: mockStatusResponse("pending_anchor") },
    ]);

    await handler.init({
      anchorUrl: "https://anchor.example.com",
      jwt: "test-jwt",
      kind: "withdrawal",
      assetCode: "USDC",
      assetIssuer: "G...ISSUER",
      amount: 50_0000000n,
      account: "G...USER",
      pollIntervalMs: 100,
    });

    const txn = handler.getTransaction();
    expect(txn).not.toBeNull();
    expect(txn!.kind).toBe("withdrawal");
    expect(txn!.amount).toBe(50_0000000n);
  });

  it("handles error status transitions", async () => {
    mockFetch([
      { status: 200, body: mockInitResponse },
      { status: 200, body: mockStatusResponse("pending_anchor") },
      { status: 200, body: { transaction: { id: "txn-abc123", status: "error", message: "KYC failed" } } },
    ]);

    handler.on("sep24StatusChanged", (event) => {
      if (event.transaction.status === "error") {
        expect(event.transaction.errorMessage).toBe("KYC failed");
      }
    });

    await handler.init({
      anchorUrl: "https://anchor.example.com",
      jwt: "test-jwt",
      kind: "deposit",
      assetCode: "USDC",
      assetIssuer: "G...ISSUER",
      amount: 100_0000000n,
      account: "G...USER",
      pollIntervalMs: 100,
    });

    await vi.advanceTimersByTimeAsync(300);
    expect(handler.getTransaction()?.status).toBe("error");
  });

  it("destroy stops polling and clears transaction", async () => {
    mockFetch([
      { status: 200, body: mockInitResponse },
      { status: 200, body: mockStatusResponse("pending_anchor") },
    ]);

    await handler.init({
      anchorUrl: "https://anchor.example.com",
      jwt: "test-jwt",
      kind: "deposit",
      assetCode: "USDC",
      assetIssuer: "G...ISSUER",
      amount: 100_0000000n,
      account: "G...USER",
      pollIntervalMs: 100,
    });

    expect(handler.getTransaction()).not.toBeNull();
    handler.destroy();
    expect(handler.getTransaction()).toBeNull();
  });
});

describe("resolveAnchorTransferServer", () => {
  it("returns TRANSFER_SERVER URL from stellar.toml", async () => {
    (StellarTomlResolver.resolve as ReturnType<typeof vi.fn>).mockResolvedValue({
      TRANSFER_SERVER: "https://api.anchor.example.com/sep24",
    });

    const result = await resolveAnchorTransferServer("anchor.example.com");
    expect(result).toBe("https://api.anchor.example.com/sep24");
  });

  it("returns null when TRANSFER_SERVER is missing", async () => {
    (StellarTomlResolver.resolve as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const result = await resolveAnchorTransferServer("anchor.example.com");
    expect(result).toBeNull();
  });

  it("returns null on resolve failure", async () => {
    (StellarTomlResolver.resolve as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Network error"),
    );

    const result = await resolveAnchorTransferServer("invalid.example.com");
    expect(result).toBeNull();
  });
});
