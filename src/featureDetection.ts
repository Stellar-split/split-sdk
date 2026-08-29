/**
 * Contract feature detection for StellarSplit SDK.
 *
 * Probes the deployed Soroban contract via read-only simulations to determine
 * which optional methods are available. Results are cached for 5 minutes to
 * avoid repeated RPC probing.
 */

import {
  Account,
  Contract,
  TransactionBuilder,
  rpc as SorobanRpc,
  BASE_FEE,
  xdr,
} from "@stellar/stellar-sdk";
import type { StellarSplitClientConfig } from "./client.js";
import type { ContractFeatures } from "./types.js";

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  features: ContractFeatures;
  expiresAt: number;
}

let _cached: CacheEntry | null = null;

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Invalidate the cached feature set (useful for testing). */
export function clearFeatureCache(): void {
  _cached = null;
}

// ---------------------------------------------------------------------------
// Feature probing
// ---------------------------------------------------------------------------

/** Contract method names that correspond to optional features. */
const FEATURE_METHODS: Record<keyof ContractFeatures, string> = {
  batchPay: "batch_pay",
  cloneInvoice: "clone_invoice",
  invoiceGroups: "group_invoices",
  templates: "templates",
  archival: "archival",
};

/**
 * Probe a single contract method via read-only simulation.
 *
 * Returns `true` if the simulation succeeds (method exists), `false` if the
 * contract host returns a "FunctionNotFound" error.
 */
async function probeMethod(
  server: SorobanRpc.Server,
  contract: Contract,
  method: string,
  source: string,
  networkPassphrase: string,
): Promise<boolean> {
  const account = new Account(source, "0");

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call(method))
    .setTimeout(30)
    .build();

  const simResult = await server.simulateTransaction(tx);

  if (SorobanRpc.Api.isSimulationError(simResult)) {
    const errorMsg =
      typeof simResult.error === "string"
        ? simResult.error
        : JSON.stringify(simResult.error);

    // Soroban / Stellar RPC returns errors like "FunctionNotFound" or
    // "MissingValue" when the contract method does not exist.
    if (
      errorMsg.includes("FunctionNotFound") ||
      errorMsg.includes("MissingValue")
    ) {
      return false;
    }

    // Any other simulation error is a problem but not necessarily
    // a missing-function indicator; we still treat it as "unavailable"
    // to be conservative.
    return false;
  }

  // Successful simulation = method exists.
  return true;
}

/**
 * Detect which optional features the deployed Soroban contract supports.
 *
 * The result is cached for 5 minutes. Call `clearFeatureCache()` to reset.
 *
 * @param config - StellarSplit client configuration (must include rpcUrl, contractId, networkPassphrase).
 * @param source  - A valid Stellar public key (G...) to use as the simulation source. Defaults to a well-known testnet address if omitted.
 * @returns A `ContractFeatures` object with booleans for each optional feature.
 */
export async function detectContractFeatures(
  config: StellarSplitClientConfig,
  source?: string,
): Promise<ContractFeatures> {
  // Return cached result if still valid
  if (_cached && Date.now() < _cached.expiresAt) {
    return { ..._cached.features };
  }

  const rpcUrl = Array.isArray(config.rpcUrl)
    ? config.rpcUrl[0]!
    : config.rpcUrl;
  const server = new SorobanRpc.Server(rpcUrl, {
    allowHttp: rpcUrl.startsWith("http://"),
  });
  const contract = new Contract(config.contractId);
  const networkPassphrase = config.networkPassphrase;
  const simSource =
    source ?? "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

  const entries = Object.entries(FEATURE_METHODS) as Array<
    [keyof ContractFeatures, string]
  >;

  // Probe all methods in parallel
  const results = await Promise.allSettled(
    entries.map(([_, method]) =>
      probeMethod(server, contract, method, simSource, networkPassphrase),
    ),
  );

  const features: ContractFeatures = {
    batchPay: false,
    cloneInvoice: false,
    invoiceGroups: false,
    templates: false,
    archival: false,
  };

  for (let i = 0; i < entries.length; i++) {
    const [key] = entries[i]!;
    const result = results[i]!;
    features[key] = result.status === "fulfilled" ? result.value : false;
  }

  // Cache the result
  _cached = { features, expiresAt: Date.now() + CACHE_TTL_MS };

  return features;
}

// === Fee-bump support

/**
 * Fee-bump transactions (CAP-0015) were introduced in Stellar protocol
 * version 13. Networks on an older base protocol cannot process them.
 */
export const FEE_BUMP_MIN_PROTOCOL_VERSION = 13;

/** Minimal network info needed to decide fee-bump availability. */
export interface FeeBumpNetworkInfo {
  /** The network's current base protocol version. */
  protocolVersion: number;
}

/**
 * Determine whether a network supports fee-bump transactions, based on its
 * base protocol version. No network calls are made; pass a network info object
 * (e.g. from Horizon's root endpoint or an RPC `getNetwork` response).
 */
export function detectFeeBumpSupport(networkInfo: FeeBumpNetworkInfo): boolean {
  return networkInfo.protocolVersion >= FEE_BUMP_MIN_PROTOCOL_VERSION;
}
