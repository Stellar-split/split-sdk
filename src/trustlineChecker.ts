/**
 * Proactive trustline verifier for non-XLM asset payments.
 *
 * Sending a non-XLM asset to a recipient who has not established a trustline
 * causes a transaction failure that is difficult to recover from gracefully.
 * This module proactively verifies that every recipient in a split invoice has
 * the required trustline before building and signing the payment transaction,
 * and surfaces a per-recipient report identifying which accounts need
 * trustlines established.
 */

import { Horizon } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result for a single recipient's trustline check. */
export interface TrustlineEntry {
  /** Stellar address of the recipient. */
  address: string;
  /** Whether the recipient has a trustline for the required token. */
  hasTrustline: boolean;
  /** The asset code (e.g. "USDC") the trustline must cover, if applicable. */
  assetCode?: string;
  /** The asset issuer / contract address for which the trustline must exist. */
  assetIssuer?: string;
}

/** Full report returned by {@link checkTrustlines}. */
export interface TrustlineCheckResult {
  /** True when every recipient has the required trustline. */
  allReady: boolean;
  /** Per-recipient results. */
  entries: TrustlineEntry[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Check whether a single account has established a trustline for a given
 * token (identified by its issuer / contract address).
 *
 * Uses {@link Horizon.Server.loadAccount} and inspects the `balances` array
 * for a matching `asset_issuer` (non-native assets) or `asset_type === "native"`
 * for XLM.
 *
 * @param server  - Horizon server instance.
 * @param address - Stellar address to check.
 * @param token   - Token contract address, or `"native"` for XLM.
 * @returns The trustline check entry.
 */
export async function checkSingleTrustline(
  server: Horizon.Server,
  address: string,
  token: string,
): Promise<TrustlineEntry> {
  // Native XLM never requires a trustline -- always passes.
  if (token === "native") {
    return { address, hasTrustline: true };
  }

  try {
    const account = await server.loadAccount(address);
    const balances = account.balances;

    const match = balances.find(
      (b) =>
        b.asset_type !== "native" &&
        b.asset_type !== "liquidity_pool_shares" &&
        (b as Horizon.HorizonApi.BalanceLineAsset).asset_issuer === token,
    );

    return {
      address,
      hasTrustline: Boolean(match),
      assetCode: match ? (match as Horizon.HorizonApi.BalanceLineAsset).asset_code : undefined,
      assetIssuer: token,
    };
  } catch {
    // Account not found or RPC error -- treat as no trustline.
    return {
      address,
      hasTrustline: false,
      assetIssuer: token,
    };
  }
}

/**
 * Verify that every recipient in a payment split has established a trustline
 * for the given token.
 *
 * Call this before building or submitting a payment transaction to surface
 * which recipients need trustlines established, avoiding hard-to-recover
 * on-chain failures.
 *
 * @param server     - Horizon server instance.
 * @param recipients - Ordered list of recipient addresses.
 * @param token      - Token contract address, or `"native"` for XLM.
 * @returns A per-recipient report.
 */
export async function checkTrustlines(
  server: Horizon.Server,
  recipients: string[],
  token: string,
): Promise<TrustlineCheckResult> {
  const entries = await Promise.all(
    recipients.map((address) => checkSingleTrustline(server, address, token)),
  );

  return {
    allReady: entries.every((e) => e.hasTrustline),
    entries,
  };
}
