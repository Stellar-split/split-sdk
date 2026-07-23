/**
 * Cross-chain bridge payment helpers for StellarSplit SDK.
 *
 * Provides fee estimation, relay-proof construction, and submission of
 * bridge payments from Ethereum / Solana toward a StellarSplit invoice on
 * Stellar Soroban.
 */

import {
  Contract,
  rpc as SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  Account,
} from "@stellar/stellar-sdk";
import type { StellarSplitClientConfig } from "./client.js";
import type {
  ChainId,
  BridgeFeeEstimate,
  BridgePaymentParams,
  BridgePaymentRequest,
  SignedBridgeProof,
} from "./types.js";
import { signTransaction } from "./wallet.js";

// ---------------------------------------------------------------------------
// Per-chain bridge configuration
// ---------------------------------------------------------------------------

/**
 * Static bridge configuration per chain.
 *
 * In a production integration these values (relayer endpoint, conversion rate,
 * bridge fee in basis points, and estimated relay time) would be fetched from
 * an on-chain oracle or the bridge relayer's REST API.  For the purposes of
 * this SDK we use well-known defaults that can be overridden via
 * {@link BridgeConfig}.
 */
export interface ChainBridgeConfig {
  /**
   * HTTP endpoint of the bridge relayer for this chain.
   * Used by estimateBridgeFee to obtain live fee quotes.
   */
  relayerEndpoint: string;
  /**
   * Approximate conversion factor: how many source-chain atomic units equal
   * one Stellar stroop (1e-7 XLM ≈ USDC peg).
   * Used when a live quote is unavailable.
   */
  atomicToStroop: number;
  /**
   * Bridge fee as basis points of the gross amount (1 bps = 0.01 %).
   * Fallback used when the relayer endpoint is unreachable.
   */
  feeBps: number;
  /**
   * Estimated relay time in seconds for this chain.
   */
  estimatedTimeSeconds: number;
}

/** Default per-chain configurations. */
export const DEFAULT_CHAIN_CONFIGS: Record<ChainId, ChainBridgeConfig> = {
  ethereum: {
    relayerEndpoint: "https://bridge-relay.stellarsplit.io/v1/ethereum",
    // 1 ETH ≈ 1e18 wei; 1 USDC ≈ 1e6 units; 1 stroop = 1e-7 USDC
    // Simplified: treat source amount as USDC micro-units (1e6) → stroops (1e7)
    atomicToStroop: 10,
    feeBps: 30, // 0.30 %
    estimatedTimeSeconds: 900, // ~15 min
  },
  solana: {
    relayerEndpoint: "https://bridge-relay.stellarsplit.io/v1/solana",
    // 1 SOL ≈ 1e9 lamports; USDC on Solana has 6 decimals
    // Treat source as USDC micro-units (1e6) → stroops (1e7)
    atomicToStroop: 10,
    feeBps: 20, // 0.20 %
    estimatedTimeSeconds: 120, // ~2 min (Solana is fast)
  },
};

/** Optional override map passed to BridgeHelper. */
export type BridgeConfig = Partial<Record<ChainId, Partial<ChainBridgeConfig>>>;

// ---------------------------------------------------------------------------
// Nonce / payload hash helpers
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically random nonce string.
 * Uses `crypto.getRandomValues` (available in both browser and Node ≥ 19).
 */
function generateNonce(): string {
  const bytes = new Uint8Array(16);
  // Node.js / browser Web Crypto API
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.getRandomValues === "function"
  ) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    // Fallback: Math.random (tests / old Node)
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Compute a deterministic hex digest for the bridge relay payload.
 *
 * The canonical payload is the pipe-delimited concatenation:
 *   `sourceChain|invoiceId|payer|amount|sourceToken|deadline|nonce`
 *
 * A real implementation would use SHA-256; here we use the same djb2-style
 * hash already used throughout the SDK (browser-compatible, no dependencies).
 */
export function computePayloadHash(
  sourceChain: ChainId,
  invoiceId: string,
  payer: string,
  amount: bigint,
  sourceToken: string,
  deadline: number,
  nonce: string,
): string {
  const data = [
    sourceChain,
    invoiceId,
    payer,
    amount.toString(),
    sourceToken,
    deadline.toString(),
    nonce,
  ].join("|");

  const encoder = new TextEncoder();
  const buf = encoder.encode(data);
  let h = 5381;
  for (let i = 0; i < buf.length; i++) {
    h = ((h << 5) + h) ^ (buf[i] ?? 0);
    h = h >>> 0; // keep 32-bit unsigned
  }
  return h.toString(16).padStart(64, "0").slice(0, 64);
}

// ---------------------------------------------------------------------------
// estimateBridgeFee
// ---------------------------------------------------------------------------

/**
 * Estimate the bridge fee for routing a payment from `sourceChain` to a
 * StellarSplit invoice.
 *
 * The function first tries to fetch a live quote from the chain's configured
 * relayer endpoint.  If the fetch fails (or is not available in the current
 * environment), it falls back to the static fee-bps and conversion-rate
 * values in {@link DEFAULT_CHAIN_CONFIGS}.
 *
 * @param sourceChain - Source chain identifier ("ethereum" | "solana").
 * @param amount      - Gross payment amount in source-chain atomic units.
 * @param config      - Optional per-chain configuration overrides.
 * @returns BridgeFeeEstimate with bridgeFee, netAmount, and estimatedTimeSeconds.
 */
export async function estimateBridgeFee(
  sourceChain: ChainId,
  amount: bigint,
  config?: BridgeConfig,
): Promise<BridgeFeeEstimate> {
  const chainDefaults = DEFAULT_CHAIN_CONFIGS[sourceChain];
  const override = config?.[sourceChain] ?? {};
  const chainCfg: ChainBridgeConfig = { ...chainDefaults, ...override };

  // Try live relayer quote
  try {
    const endpoint = chainCfg.relayerEndpoint;
    const url = `${endpoint}/fee?amount=${amount.toString()}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      const json = (await response.json()) as {
        bridge_fee?: string | number;
        net_amount?: string | number;
        estimated_seconds?: number;
      };
      if (json.bridge_fee !== undefined && json.net_amount !== undefined) {
        return {
          bridgeFee: BigInt(json.bridge_fee),
          netAmount: BigInt(json.net_amount),
          estimatedTimeSeconds:
            json.estimated_seconds ?? chainCfg.estimatedTimeSeconds,
        };
      }
    }
  } catch {
    // Relayer unreachable — use static fallback below
  }

  // Static fallback: compute fee from basis points
  const bridgeFee = (amount * BigInt(chainCfg.feeBps)) / 10000n;
  const grossAfterFee = amount - bridgeFee;
  const netAmount = grossAfterFee * BigInt(chainCfg.atomicToStroop);

  return {
    bridgeFee,
    netAmount,
    estimatedTimeSeconds: chainCfg.estimatedTimeSeconds,
  };
}

// ---------------------------------------------------------------------------
// buildBridgePayment
// ---------------------------------------------------------------------------

/**
 * Build an unsigned bridge relay proof struct for the given payment parameters.
 *
 * The resulting {@link BridgePaymentRequest} must be signed by the payer's
 * source-chain wallet before it can be submitted via
 * {@link submitBridgePayment}.
 *
 * @param params - Payment parameters (chain, payer, invoiceId, amount, etc.).
 * @returns Unsigned BridgePaymentRequest ready for source-chain signing.
 */
export function buildBridgePayment(
  params: BridgePaymentParams,
): BridgePaymentRequest {
  const {
    sourceChain,
    payer,
    invoiceId,
    amount,
    sourceToken,
    deadline,
  } = params;

  const nonce = generateNonce();
  const payloadHash = computePayloadHash(
    sourceChain,
    invoiceId,
    payer,
    amount,
    sourceToken,
    deadline,
    nonce,
  );

  return {
    sourceChain,
    invoiceId,
    payer,
    amount,
    sourceToken,
    deadline,
    nonce,
    payloadHash,
  };
}

// ---------------------------------------------------------------------------
// submitBridgePayment
// ---------------------------------------------------------------------------

/**
 * Internal type for an injectable Soroban RPC server (used in tests).
 * @internal
 */
export type SorobanServerLike = Pick<
  SorobanRpc.Server,
  "getAccount" | "simulateTransaction" | "sendTransaction" | "getTransaction"
>;

/**
 * Injectable dependencies for submitBridgePayment (for testing only).
 * @internal
 */
export interface BridgePayDeps {
  /** Pre-built RPC server — skips new SorobanRpc.Server() */
  server?: SorobanServerLike;
  /** Stub for assembleTransaction */
  assembleTransaction?: (tx: any, sim: any) => { build(): { toXDR(): string } };
  /** Stub for TransactionBuilder.fromXDR */
  fromXDR?: (xdr: string, passphrase: string) => any;
  /** Stub for signTransaction */
  signTransaction?: (xdr: string, network: string) => Promise<string>;
  /** Stub for new Contract() call result */
  contractCall?: (...args: any[]) => any;
  /** Stub for building + submitting the Stellar tx (replaces TransactionBuilder) */
  buildTx?: (account: any, operation: any, passphrase: string) => { toXDR(): string };
}

/**
 * Submit a signed bridge payment proof to the StellarSplit contract's
 * `bridge_pay` entry point.
 *
 * The contract entry point is expected to accept:
 *   bridge_pay(invoice_id: u64, payer: Address, amount: i128,
 *              source_chain: String, payload_hash: String, signature: String)
 *
 * @param proof         - Signed bridge proof from the source-chain wallet.
 * @param clientConfig  - StellarSplitClient configuration (rpcUrl, contractId, etc.).
 * @param _deps         - Optional injectable dependencies (for testing only).
 * @returns Transaction hash of the submitted bridge payment.
 */
export async function submitBridgePayment(
  proof: SignedBridgeProof,
  clientConfig: StellarSplitClientConfig,
  _deps?: BridgePayDeps,
): Promise<{ txHash: string }> {
  const { request, signature } = proof;

  if (!request.payloadHash) {
    throw new Error("Invalid bridge proof: missing payloadHash");
  }

  if (!signature || signature.length === 0) {
    throw new Error("Invalid bridge proof: missing signature");
  }

  const rpcUrl = Array.isArray(clientConfig.rpcUrl)
    ? clientConfig.rpcUrl[0]!
    : clientConfig.rpcUrl;

  const server: SorobanServerLike = _deps?.server ?? new SorobanRpc.Server(rpcUrl, {
    allowHttp: rpcUrl.startsWith("http://"),
  });

  // Build the bridge_pay contract call operation via injectable or real Contract
  let operation: any;
  if (_deps?.contractCall) {
    operation = _deps.contractCall(
      "bridge_pay",
      request.invoiceId,
      request.payer,
      request.amount,
      request.sourceChain,
      request.payloadHash,
      signature,
    );
  } else {
    const contract = new Contract(clientConfig.contractId);
    operation = contract.call(
      "bridge_pay",
      nativeToScVal(BigInt(request.invoiceId), { type: "u64" }),
      nativeToScVal(request.payer, { type: "address" }),
      nativeToScVal(request.amount, { type: "i128" }),
      nativeToScVal(request.sourceChain, { type: "string" }),
      nativeToScVal(request.payloadHash, { type: "string" }),
      nativeToScVal(signature, { type: "string" }),
    );
  }

  // Use the payer's Stellar address as the source account
  const sourceAddress = request.payer;
  const account = await server.getAccount(sourceAddress);

  // Build the transaction (injectable for tests)
  let tx: any;
  if (_deps?.buildTx) {
    tx = _deps.buildTx(account, operation, clientConfig.networkPassphrase);
  } else {
    tx = new TransactionBuilder(account as unknown as Account, {
      fee: BASE_FEE,
      networkPassphrase: clientConfig.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();
  }

  // Simulate to validate and get resource fee
  const simResult = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(simResult)) {
    throw new Error(`Bridge pay simulation failed: ${(simResult as any).error}`);
  }

  // Assemble and sign
  const _assembleTransaction = _deps?.assembleTransaction ?? SorobanRpc.assembleTransaction;
  const preparedTx = _assembleTransaction(tx, simResult).build();
  const preparedXdr: string =
    typeof preparedTx === "string"
      ? preparedTx
      : typeof preparedTx?.toXDR === "function"
        ? (preparedTx.toXDR() as string)
        : String(preparedTx);

  const adapter = (clientConfig as {
    adapter?: { signTransaction: (xdr: string, network: string) => Promise<string> };
  }).adapter;
  const _sign = _deps?.signTransaction ?? (adapter?.signTransaction.bind(adapter)) ??
    ((xdr: string, network: string) => signTransaction(xdr, network));
  const signedXdr = await _sign(preparedXdr, clientConfig.networkPassphrase);

  // Submit
  const _fromXDR = _deps?.fromXDR ?? TransactionBuilder.fromXDR.bind(TransactionBuilder);
  const sendResult = await server.sendTransaction(
    _fromXDR(signedXdr, clientConfig.networkPassphrase),
  );

  if ((sendResult as any).status === "ERROR") {
    const errorResult = sendResult as { errorResult?: { toXDR?: () => unknown }; status: string };
    throw new Error(
      `Bridge pay transaction failed: ${JSON.stringify(errorResult.errorResult?.toXDR?.() ?? errorResult.status)}`,
    );
  }

  // Poll for confirmation
  const txHash = (sendResult as any).hash as string;
  const maxAttempts = 20;
  for (let i = 0; i < maxAttempts; i++) {
    await _sleep(1500);
    const status = await server.getTransaction(txHash);
    if ((status as any).status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      return { txHash };
    }
    if ((status as any).status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`Bridge pay transaction failed on-chain: ${txHash}`);
    }
  }

  throw new Error(
    `Bridge pay transaction not confirmed after ${maxAttempts} attempts: ${txHash}`,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
