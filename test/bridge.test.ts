/**
 * Tests for cross-chain bridge payment helpers.
 *
 * All external calls (fetch, Soroban RPC) are mocked so the suite runs
 * offline without any live network.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  estimateBridgeFee,
  buildBridgePayment,
  submitBridgePayment,
  computePayloadHash,
  DEFAULT_CHAIN_CONFIGS,
} from "../src/bridge.js";
import type {
  ChainId,
  BridgeFeeEstimate,
  BridgePaymentParams,
  BridgePaymentRequest,
  SignedBridgeProof,
} from "../src/types.js";

// ---------------------------------------------------------------------------
// Shared test constants
// ---------------------------------------------------------------------------

const PAYER = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const INVOICE_ID = "42";
const DEADLINE = Math.floor(Date.now() / 1000) + 3600;
const ETH_TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // USDC on Ethereum
const SOL_TOKEN = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC on Solana

// ---------------------------------------------------------------------------
// computePayloadHash
// ---------------------------------------------------------------------------

describe("computePayloadHash", () => {
  it("returns a 64-character hex string", () => {
    const hash = computePayloadHash(
      "ethereum",
      INVOICE_ID,
      PAYER,
      1_000_000n,
      ETH_TOKEN,
      DEADLINE,
      "deadbeef",
    );
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it("is deterministic for the same inputs", () => {
    const args: Parameters<typeof computePayloadHash> = [
      "solana",
      INVOICE_ID,
      PAYER,
      500_000n,
      SOL_TOKEN,
      DEADLINE,
      "cafebabe",
    ];
    expect(computePayloadHash(...args)).toBe(computePayloadHash(...args));
  });

  it("changes when any input changes", () => {
    const base: Parameters<typeof computePayloadHash> = [
      "ethereum",
      INVOICE_ID,
      PAYER,
      1_000_000n,
      ETH_TOKEN,
      DEADLINE,
      "nonce1",
    ];
    const diffChain: Parameters<typeof computePayloadHash> = [
      "solana",
      ...base.slice(1) as [string, string, bigint, string, number, string],
    ];
    expect(computePayloadHash(...base)).not.toBe(computePayloadHash(...diffChain));
  });

  it("produces different hashes for different nonces", () => {
    const h1 = computePayloadHash("ethereum", INVOICE_ID, PAYER, 100n, ETH_TOKEN, DEADLINE, "nonce_a");
    const h2 = computePayloadHash("ethereum", INVOICE_ID, PAYER, 100n, ETH_TOKEN, DEADLINE, "nonce_b");
    expect(h1).not.toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_CHAIN_CONFIGS
// ---------------------------------------------------------------------------

describe("DEFAULT_CHAIN_CONFIGS", () => {
  it("defines ethereum config", () => {
    const cfg = DEFAULT_CHAIN_CONFIGS.ethereum;
    expect(cfg.feeBps).toBeGreaterThan(0);
    expect(cfg.estimatedTimeSeconds).toBeGreaterThan(0);
    expect(cfg.relayerEndpoint).toContain("ethereum");
    expect(cfg.atomicToStroop).toBeGreaterThan(0);
  });

  it("defines solana config", () => {
    const cfg = DEFAULT_CHAIN_CONFIGS.solana;
    expect(cfg.feeBps).toBeGreaterThan(0);
    expect(cfg.estimatedTimeSeconds).toBeGreaterThan(0);
    expect(cfg.relayerEndpoint).toContain("solana");
    expect(cfg.atomicToStroop).toBeGreaterThan(0);
  });

  it("solana is faster than ethereum", () => {
    expect(DEFAULT_CHAIN_CONFIGS.solana.estimatedTimeSeconds).toBeLessThan(
      DEFAULT_CHAIN_CONFIGS.ethereum.estimatedTimeSeconds,
    );
  });
});

// ---------------------------------------------------------------------------
// estimateBridgeFee — static fallback (fetch not available / fails)
// ---------------------------------------------------------------------------

describe("estimateBridgeFee — static fallback", () => {
  beforeEach(() => {
    // Make fetch fail so we always use the static fallback
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network unavailable")));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns valid estimate for Ethereum", async () => {
    const amount = 1_000_000n; // 1 USDC in micro-units
    const estimate = await estimateBridgeFee("ethereum", amount);

    expect(estimate).toMatchObject<Partial<BridgeFeeEstimate>>({
      bridgeFee: expect.any(BigInt),
      netAmount: expect.any(BigInt),
      estimatedTimeSeconds: expect.any(Number),
    });
    expect(estimate.bridgeFee).toBeGreaterThan(0n);
    expect(estimate.netAmount).toBeGreaterThan(0n);
    expect(estimate.estimatedTimeSeconds).toBe(DEFAULT_CHAIN_CONFIGS.ethereum.estimatedTimeSeconds);
  });

  it("returns valid estimate for Solana", async () => {
    const amount = 1_000_000n;
    const estimate = await estimateBridgeFee("solana", amount);

    expect(estimate.bridgeFee).toBeGreaterThan(0n);
    expect(estimate.netAmount).toBeGreaterThan(0n);
    expect(estimate.estimatedTimeSeconds).toBe(DEFAULT_CHAIN_CONFIGS.solana.estimatedTimeSeconds);
  });

  it("netAmount is less than gross (fee deducted)", async () => {
    const amount = 1_000_000n;
    const eth = await estimateBridgeFee("ethereum", amount);
    const grossAfterFee = amount - eth.bridgeFee;
    // netAmount = grossAfterFee * atomicToStroop
    expect(eth.netAmount).toBe(
      grossAfterFee * BigInt(DEFAULT_CHAIN_CONFIGS.ethereum.atomicToStroop),
    );
  });

  it("bridgeFee is proportional to feeBps", async () => {
    const amount = 10_000n;
    const estimate = await estimateBridgeFee("ethereum", amount);
    const expectedFee =
      (amount * BigInt(DEFAULT_CHAIN_CONFIGS.ethereum.feeBps)) / 10_000n;
    expect(estimate.bridgeFee).toBe(expectedFee);
  });

  it("accepts custom config overrides", async () => {
    const amount = 1_000_000n;
    const estimate = await estimateBridgeFee("ethereum", amount, {
      ethereum: { feeBps: 100, estimatedTimeSeconds: 600 },
    });
    const expectedFee = (amount * 100n) / 10_000n;
    expect(estimate.bridgeFee).toBe(expectedFee);
    expect(estimate.estimatedTimeSeconds).toBe(600);
  });
});

// ---------------------------------------------------------------------------
// estimateBridgeFee — live relayer mock
// ---------------------------------------------------------------------------

describe("estimateBridgeFee — live relayer response", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses live relayer data when available", async () => {
    const liveResponse = {
      bridge_fee: "300",
      net_amount: "9700000",
      estimated_seconds: 800,
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => liveResponse,
      }),
    );

    const estimate = await estimateBridgeFee("ethereum", 1_000_000n);
    expect(estimate.bridgeFee).toBe(300n);
    expect(estimate.netAmount).toBe(9_700_000n);
    expect(estimate.estimatedTimeSeconds).toBe(800);
  });

  it("falls back to static when relayer returns non-ok status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    );

    const estimate = await estimateBridgeFee("ethereum", 1_000_000n);
    // Should still return a valid estimate using static fallback
    expect(estimate.bridgeFee).toBeGreaterThan(0n);
    expect(estimate.netAmount).toBeGreaterThan(0n);
  });

  it("falls back to static when relayer returns incomplete JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ some_other_field: 123 }),
      }),
    );

    const estimate = await estimateBridgeFee("solana", 500_000n);
    expect(estimate.bridgeFee).toBeGreaterThan(0n);
  });
});

// ---------------------------------------------------------------------------
// buildBridgePayment
// ---------------------------------------------------------------------------

describe("buildBridgePayment", () => {
  const baseParams: BridgePaymentParams = {
    sourceChain: "ethereum",
    payer: PAYER,
    invoiceId: INVOICE_ID,
    amount: 1_000_000n,
    sourceToken: ETH_TOKEN,
    deadline: DEADLINE,
  };

  it("returns a BridgePaymentRequest with all required fields", () => {
    const req = buildBridgePayment(baseParams);
    expect(req.sourceChain).toBe("ethereum");
    expect(req.invoiceId).toBe(INVOICE_ID);
    expect(req.payer).toBe(PAYER);
    expect(req.amount).toBe(1_000_000n);
    expect(req.sourceToken).toBe(ETH_TOKEN);
    expect(req.deadline).toBe(DEADLINE);
    expect(req.nonce).toBeTruthy();
    expect(req.payloadHash).toBeTruthy();
  });

  it("nonce is a non-empty hex string", () => {
    const req = buildBridgePayment(baseParams);
    expect(req.nonce).toMatch(/^[0-9a-f]+$/);
    expect(req.nonce.length).toBeGreaterThan(0);
  });

  it("payloadHash has length 64", () => {
    const req = buildBridgePayment(baseParams);
    expect(req.payloadHash).toHaveLength(64);
  });

  it("each call produces a unique nonce", () => {
    const req1 = buildBridgePayment(baseParams);
    const req2 = buildBridgePayment(baseParams);
    expect(req1.nonce).not.toBe(req2.nonce);
  });

  it("payloadHash matches computePayloadHash with same inputs", () => {
    const req = buildBridgePayment(baseParams);
    const expected = computePayloadHash(
      req.sourceChain,
      req.invoiceId,
      req.payer,
      req.amount,
      req.sourceToken,
      req.deadline,
      req.nonce,
    );
    expect(req.payloadHash).toBe(expected);
  });

  it("works for Solana source chain", () => {
    const solParams: BridgePaymentParams = {
      ...baseParams,
      sourceChain: "solana",
      sourceToken: SOL_TOKEN,
    };
    const req = buildBridgePayment(solParams);
    expect(req.sourceChain).toBe("solana");
    expect(req.sourceToken).toBe(SOL_TOKEN);
  });

  it("preserves all parameter values", () => {
    const req = buildBridgePayment(baseParams);
    expect(req.invoiceId).toBe(baseParams.invoiceId);
    expect(req.payer).toBe(baseParams.payer);
    expect(req.amount).toBe(baseParams.amount);
    expect(req.sourceToken).toBe(baseParams.sourceToken);
    expect(req.deadline).toBe(baseParams.deadline);
  });
});

// ---------------------------------------------------------------------------
// submitBridgePayment — mock contract responses
// ---------------------------------------------------------------------------

describe("submitBridgePayment", () => {
  const CLIENT_CONFIG = {
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CCJGSXWNBGGKQ4YLEFLNFK55UQ3IXNXZ7WOCBX3XQLQJWBJD2A4XTAQ",
  };

  function makeProof(overrides?: Partial<BridgePaymentRequest>): SignedBridgeProof {
    const request: BridgePaymentRequest = {
      sourceChain: "ethereum",
      invoiceId: INVOICE_ID,
      payer: PAYER,
      amount: 1_000_000n,
      sourceToken: ETH_TOKEN,
      deadline: DEADLINE,
      nonce: "aabbccdd1122",
      payloadHash: "a".repeat(64),
      ...overrides,
    };
    return {
      request,
      signature: "0xdeadbeef0123456789",
      signerAddress: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    };
  }

  /** Builds injectable deps that fully bypass the real Stellar SDK. */
  function buildDeps(txHash = "mock_tx_hash_abc123", serverOverrides?: Record<string, unknown>) {
    const mockServer = {
      getAccount: vi.fn().mockResolvedValue({ id: PAYER, sequence: "100" }),
      simulateTransaction: vi.fn().mockResolvedValue({
        minResourceFee: "1000",
        transactionData: "",
        results: [],
        cost: { cpuInsns: "0", memBytes: "0" },
        latestLedger: 100,
      }),
      sendTransaction: vi.fn().mockResolvedValue({
        status: "PENDING",
        hash: txHash,
      }),
      getTransaction: vi.fn().mockResolvedValue({
        status: "SUCCESS",
        txHash,
        ledger: 12345,
      }),
      ...serverOverrides,
    };

    return {
      server: mockServer,
      // Bypass TransactionBuilder entirely
      buildTx: vi.fn().mockReturnValue({ toXDR: () => "MOCK_TX_XDR" }),
      assembleTransaction: vi.fn().mockReturnValue({
        build: () => ({ toXDR: () => "MOCK_PREPARED_XDR" }),
      }),
      fromXDR: vi.fn().mockReturnValue({}),
      signTransaction: vi.fn().mockResolvedValue("MOCK_SIGNED_XDR"),
      contractCall: vi.fn().mockReturnValue({ toXDR: () => Buffer.alloc(0) }),
    };
  }

  it("throws when payloadHash is missing", async () => {
    const proof = makeProof({ payloadHash: "" });
    await expect(
      submitBridgePayment(proof, CLIENT_CONFIG),
    ).rejects.toThrow("missing payloadHash");
  });

  it("throws when signature is empty", async () => {
    const proof: SignedBridgeProof = {
      ...makeProof(),
      signature: "",
    };
    await expect(
      submitBridgePayment(proof, CLIENT_CONFIG),
    ).rejects.toThrow("missing signature");
  });

  it("calls getAccount and sendTransaction, returns txHash", async () => {
    const deps = buildDeps("bridge_tx_001");
    const proof = makeProof();
    const result = await submitBridgePayment(proof, CLIENT_CONFIG, deps);

    expect(result).toHaveProperty("txHash", "bridge_tx_001");
    expect(deps.server.getAccount).toHaveBeenCalledWith(PAYER);
    expect(deps.server.sendTransaction).toHaveBeenCalled();
    expect(deps.server.getTransaction).toHaveBeenCalled();
  });

  it("throws when on-chain transaction fails", async () => {
    const deps = buildDeps("fail_tx", {
      getTransaction: vi.fn().mockResolvedValue({ status: "FAILED", txHash: "fail_tx" }),
    });
    const proof = makeProof();
    await expect(submitBridgePayment(proof, CLIENT_CONFIG, deps)).rejects.toThrow(
      "failed on-chain",
    );
  });

  it("throws when simulation returns an error", async () => {
    const { rpc: SorobanRpc } = await import("@stellar/stellar-sdk");
    const deps = buildDeps();
    // Override the mock server to return a sim error
    deps.server.simulateTransaction = vi.fn().mockResolvedValue({ error: "reverted" });
    // Override isSimulationError check by making the simResult look like an error
    // We test the path where isSimulationError returns true
    const origCheck = SorobanRpc.Api.isSimulationError;
    SorobanRpc.Api.isSimulationError = (_r: any) => true;
    try {
      const proof = makeProof();
      await expect(submitBridgePayment(proof, CLIENT_CONFIG, deps)).rejects.toThrow(
        "simulation failed",
      );
    } finally {
      SorobanRpc.Api.isSimulationError = origCheck;
    }
  });

  it("throws when sendTransaction returns ERROR status", async () => {
    const deps = buildDeps("err_hash", {
      sendTransaction: vi.fn().mockResolvedValue({ status: "ERROR", hash: "err_hash" }),
    });
    const proof = makeProof();
    await expect(submitBridgePayment(proof, CLIENT_CONFIG, deps)).rejects.toThrow(
      "Bridge pay transaction failed",
    );
  });
});

// ---------------------------------------------------------------------------
// Type-level integration: BridgePaymentRequest satisfies SignedBridgeProof.request
// ---------------------------------------------------------------------------

describe("type integration", () => {
  it("BridgePaymentRequest can be wrapped in SignedBridgeProof", () => {
    const request = buildBridgePayment({
      sourceChain: "solana",
      payer: PAYER,
      invoiceId: "99",
      amount: 5_000_000n,
      sourceToken: SOL_TOKEN,
      deadline: DEADLINE,
    });

    const proof: SignedBridgeProof = {
      request,
      signature: "sig_bytes_here",
      signerAddress: "4Qk...solana_address",
    };

    expect(proof.request.sourceChain).toBe("solana");
    expect(proof.request.invoiceId).toBe("99");
    expect(proof.signerAddress).toBeTruthy();
  });
});
