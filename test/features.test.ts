import { describe, it, expect, vi } from "vitest";
import { StellarSplitClient } from "../src/client.js";
import { StrKey, Keypair, nativeToScVal } from "@stellar/stellar-sdk";

function createClient() {
  return new StellarSplitClient({
    rpcUrl: "https://example.com",
    networkPassphrase: "Test Network",
    contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
  });
}

describe("getScheduledReleaseCountdown", () => {
  it("returns overdue when target is in the past", () => {
    const client = createClient();
    const result = client.getScheduledReleaseCountdown(
      Math.floor(Date.now() / 1000) - 3600
    );
    expect(result.overdue).toBe(true);
    expect(result.days).toBe(0);
    expect(result.hours).toBe(0);
    expect(result.minutes).toBe(0);
    expect(result.seconds).toBe(0);
  });

  it("computes correct countdown for a future timestamp", () => {
    const client = createClient();
    const future = Math.floor(Date.now() / 1000) + 90061;
    const result = client.getScheduledReleaseCountdown(future);
    expect(result.days).toBe(1);
    expect(result.hours).toBe(1);
    expect(result.minutes).toBe(1);
    expect(result.seconds).toBe(1);
    expect(result.overdue).toBe(false);
  });

  it("uses scheduledReleaseDate from invoice when available", () => {
    const client = createClient();
    const future = Math.floor(Date.now() / 1000) + 86400;
    const result = client.getScheduledReleaseCountdown({
      id: "1",
      creator: "G",
      recipients: [],
      token: "G",
      deadline: Math.floor(Date.now() / 1000) + 999999,
      funded: 0n,
      status: "Pending",
      payments: [],
      scheduledReleaseDate: future,
    });
    expect(result.days).toBe(1);
    expect(result.hours).toBe(0);
    expect(result.minutes).toBe(0);
    expect(result.seconds).toBe(0);
    expect(result.overdue).toBe(false);
  });

  it("falls back to deadline when no scheduledReleaseDate", () => {
    const client = createClient();
    const future = Math.floor(Date.now() / 1000) + 172800;
    const result = client.getScheduledReleaseCountdown({
      id: "1",
      creator: "G",
      recipients: [],
      token: "G",
      deadline: future,
      funded: 0n,
      status: "Pending",
      payments: [],
    });
    expect(result.days).toBe(2);
    expect(result.overdue).toBe(false);
  });
});

describe("raiseDispute", () => {
  it("submits dispute_invoice and returns disputeId", async () => {
    const client = createClient();
    const submitSpy = vi.spyOn(client as any, "_submitTx").mockResolvedValue({
      txHash: "tx-dispute",
      returnValue: nativeToScVal(BigInt("42"), { type: "u64" }),
    } as any);

    const result = await client.raiseDispute("123");
    expect(result.disputeId).toBe("42");
    expect(result.txHash).toBe("tx-dispute");
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });
});

describe("resolveDispute", () => {
  it("submits resolve_dispute with arbiter signing", async () => {
    const client = createClient();
    const submitSpy = vi.spyOn(client as any, "_submitTx").mockResolvedValue({
      txHash: "tx-resolve",
      returnValue: nativeToScVal(BigInt("7"), { type: "u64" }),
    } as any);

    const arbiter = Keypair.random().publicKey();
    const result = await client.resolveDispute("123", arbiter);
    expect(result.disputeId).toBe("7");
    expect(result.txHash).toBe("tx-resolve");
    expect(submitSpy).toHaveBeenCalledWith(
      arbiter,
      expect.anything()
    );
  });
});

describe("getDisputeStatus", () => {
  it("returns parsed dispute status from contract", async () => {
    const client = createClient();
    vi.spyOn(client as any, "_simulateView").mockResolvedValue({
      disputed: true,
      arbiter: Keypair.random().publicKey(),
      resolved: false,
      resolution: null,
    });

    const status = await client.getDisputeStatus("123");
    expect(status.invoiceId).toBe("123");
    expect(status.disputed).toBe(true);
    expect(status.resolved).toBe(false);
    expect(status.resolution).toBeNull();
  });

  it("parses approved resolution", async () => {
    const client = createClient();
    vi.spyOn(client as any, "_simulateView").mockResolvedValue({
      disputed: true,
      arbiter: Keypair.random().publicKey(),
      resolved: true,
      resolution: "approved",
    });

    const status = await client.getDisputeStatus("123");
    expect(status.resolved).toBe(true);
    expect(status.resolution).toBe("approved");
  });
});

describe("placeBid", () => {
  it("submits place_bid and returns txHash", async () => {
    const client = createClient();
    const submitSpy = vi.spyOn(client as any, "_submitTx").mockResolvedValue({
      txHash: "tx-bid",
    } as any);

    const bidder = Keypair.random().publicKey();
    const result = await client.placeBid(bidder, "123", 1_000_000n);
    expect(result.txHash).toBe("tx-bid");
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });
});

describe("settleAuction", () => {
  it("submits settle_auction and returns txHash", async () => {
    const client = createClient();
    const submitSpy = vi.spyOn(client as any, "_submitTx").mockResolvedValue({
      txHash: "tx-settle",
    } as any);

    const caller = Keypair.random().publicKey();
    const result = await client.settleAuction(caller, "123");
    expect(result.txHash).toBe("tx-settle");
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });
});

describe("getAuctionInfo", () => {
  it("returns parsed auction state", async () => {
    const client = createClient();
    const bidder = Keypair.random().publicKey();
    vi.spyOn(client as any, "_simulateView").mockResolvedValue({
      active: true,
      highestBid: { bidder, amount: "5000000", timestamp: 1700000000 },
      endTime: 1800000000,
    });

    const info = await client.getAuctionInfo("123");
    expect(info.invoiceId).toBe("123");
    expect(info.active).toBe(true);
    expect(info.highestBid).not.toBeNull();
    expect(info.highestBid!.bidder).toBe(bidder);
    expect(info.highestBid!.amount).toBe(5_000_000n);
    expect(info.endTime).toBe(1_800_000_000);
  });

  it("handles no bids", async () => {
    const client = createClient();
    vi.spyOn(client as any, "_simulateView").mockResolvedValue({
      active: true,
      highestBid: null,
      endTime: 1800000000,
    });

    const info = await client.getAuctionInfo("123");
    expect(info.highestBid).toBeNull();
  });
});

describe("queueAction", () => {
  it("submits queue_action and returns actionId", async () => {
    const client = createClient();
    vi.spyOn(client as any, "_submitTx").mockResolvedValue({
      txHash: "tx-queue",
      returnValue: nativeToScVal(BigInt("99"), { type: "u64" }),
    } as any);

    const caller = Keypair.random().publicKey();
    const result = await client.queueAction({
      caller,
      actionType: "update_treasury",
      target: Keypair.random().publicKey(),
      value: 1_000_000n,
      eta: Math.floor(Date.now() / 1000) + 86400,
    });
    expect(result.actionId).toBe("99");
    expect(result.txHash).toBe("tx-queue");
  });
});

describe("executeAction", () => {
  it("submits execute_action and returns txHash", async () => {
    const client = createClient();
    const submitSpy = vi.spyOn(client as any, "_submitTx").mockResolvedValue({
      txHash: "tx-exec",
    } as any);

    const caller = Keypair.random().publicKey();
    const result = await client.executeAction(caller, "99");
    expect(result.txHash).toBe("tx-exec");
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });
});

describe("cancelAction", () => {
  it("submits cancel_action and returns txHash", async () => {
    const client = createClient();
    const submitSpy = vi.spyOn(client as any, "_submitTx").mockResolvedValue({
      txHash: "tx-cancel",
    } as any);

    const caller = Keypair.random().publicKey();
    const result = await client.cancelAction(caller, "99");
    expect(result.txHash).toBe("tx-cancel");
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });
});

describe("getActionStatus", () => {
  it("returns parsed action status", async () => {
    const client = createClient();
    vi.spyOn(client as any, "_simulateView").mockResolvedValue({
      actionType: "update_fee",
      target: Keypair.random().publicKey(),
      value: "500000",
      eta: 1800000000,
      executed: false,
      cancelled: false,
    });

    const status = await client.getActionStatus("99");
    expect(status.actionId).toBe("99");
    expect(status.actionType).toBe("update_fee");
    expect(status.value).toBe(500_000n);
    expect(status.executed).toBe(false);
    expect(status.cancelled).toBe(false);
  });

  it("correctly flags executed actions", async () => {
    const client = createClient();
    vi.spyOn(client as any, "_simulateView").mockResolvedValue({
      actionType: "update_treasury",
      target: Keypair.random().publicKey(),
      value: "1000000",
      eta: 1800000000,
      executed: true,
      cancelled: false,
    });

    const status = await client.getActionStatus("99");
    expect(status.executed).toBe(true);
    expect(status.cancelled).toBe(false);
  });
});
