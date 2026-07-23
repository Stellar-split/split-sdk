import { describe, it, expect } from "vitest";
import { MockRpcClient } from "../src/testing/mockRpcClient.js";
import type { RpcClient } from "../src/rpcClient.js";
import { Account, Keypair, StrKey } from "@stellar/stellar-sdk";

const TEST_ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const TEST_CONTRACT_ID = StrKey.encodeContract(Keypair.random().rawPublicKey());

describe("MockRpcClient", () => {
  it("implements the RpcClient interface", () => {
    const mock: RpcClient = new MockRpcClient();
    expect(typeof mock.simulateTransaction).toBe("function");
    expect(typeof mock.sendTransaction).toBe("function");
    expect(typeof mock.getTransaction).toBe("function");
    expect(typeof mock.getEvents).toBe("function");
    expect(typeof mock.getLatestLedger).toBe("function");
    expect(typeof mock.getAccount).toBe("function");
    expect(typeof mock.getFeeStats).toBe("function");
  });

  it("getAccount returns an object with accountId() for a G address", async () => {
    const mock = new MockRpcClient();
    const account = await mock.getAccount(TEST_ADDRESS);
    expect(typeof account.accountId).toBe("function");
    expect(account.accountId()).toBe(TEST_ADDRESS);
  });

  it("simulateTransaction returns the default response", async () => {
    const mock = new MockRpcClient();
    const resp = await mock.simulateTransaction({} as any);
    expect(resp).toBeDefined();
  });

  it("queued simulate responses are returned in order", async () => {
    const mock = new MockRpcClient();
    const r1 = { latestLedger: 1 } as any;
    const r2 = { latestLedger: 2 } as any;
    mock.queueSimulateResponse(r1).queueSimulateResponse(r2);

    const a = await mock.simulateTransaction({} as any);
    const b = await mock.simulateTransaction({} as any);
    expect(a.latestLedger).toBe(1);
    expect(b.latestLedger).toBe(2);
  });

  it("queued Error is thrown from simulateTransaction", async () => {
    const mock = new MockRpcClient();
    mock.queueSimulateResponse(new Error("network error"));
    await expect(mock.simulateTransaction({} as any)).rejects.toThrow("network error");
  });

  it("sendTransaction records calls", async () => {
    const mock = new MockRpcClient();
    await mock.sendTransaction({} as any);
    await mock.sendTransaction({} as any);
    expect(mock.calls.send).toHaveLength(2);
  });

  it("getTransaction records the requested hash", async () => {
    const mock = new MockRpcClient();
    await mock.getTransaction("abc123");
    expect(mock.calls.getTransaction).toContain("abc123");
  });

  it("queued getTransaction Error is thrown", async () => {
    const mock = new MockRpcClient();
    mock.queueGetTransactionResponse(new Error("tx not found"));
    await expect(mock.getTransaction("hash")).rejects.toThrow("tx not found");
  });

  it("getLatestLedger returns default response", async () => {
    const mock = new MockRpcClient();
    const resp = await mock.getLatestLedger();
    expect(resp).toBeDefined();
    expect(typeof (resp as any).sequence).toBe("number");
  });

  it("getFeeStats returns default response", async () => {
    const mock = new MockRpcClient();
    const stats = await mock.getFeeStats();
    expect(stats).toBeDefined();
    expect((stats as any).sorobanInclusionFee).toBeDefined();
  });

  it("reset() clears queues and call records", async () => {
    const mock = new MockRpcClient();
    mock.queueSimulateResponse({ latestLedger: 99 } as any);
    await mock.simulateTransaction({} as any);
    mock.reset();
    expect(mock.calls.simulate).toHaveLength(0);
    // After reset, the queue is empty; default response is returned
    const resp = await mock.simulateTransaction({} as any);
    // Default response comes from constructor defaults
    expect(resp).toBeDefined();
  });

  it("setDefaultSimulateResponse overrides the default", async () => {
    const mock = new MockRpcClient();
    mock.setDefaultSimulateResponse({ latestLedger: 999, id: "custom" } as any);
    const resp = await mock.simulateTransaction({} as any);
    expect((resp as any).latestLedger).toBe(999);
  });
});

describe("StellarSplitClient with injected rpcClient", () => {
  it("accepts an rpcClient option in config without throwing", async () => {
    const { StellarSplitClient } = await import("../src/client.js");
    const mock = new MockRpcClient();

    const client = new StellarSplitClient({
      rpcUrl: "http://localhost:8000",
      networkPassphrase: "Test SDF Network ; September 2015",
      contractId: TEST_CONTRACT_ID,
      rpcClient: mock,
    });

    expect(client).toBeDefined();
  });

  it("routes RPC calls through the injected client (getEvents)", async () => {
    const { StellarSplitClient } = await import("../src/client.js");
    const mock = new MockRpcClient();

    const client = new StellarSplitClient({
      rpcUrl: "http://localhost:8000",
      networkPassphrase: "Test SDF Network ; September 2015",
      contractId: TEST_CONTRACT_ID,
      rpcClient: mock,
    });

    // checkRPCHealth uses getLatestLedger which is delegated through server getter
    // We can test directly that the client's server getter returns the mock
    const latestLedger = await (client as any).server.getLatestLedger();
    expect(latestLedger).toBeDefined();
    expect(latestLedger.sequence).toBe(100);
  });
});
