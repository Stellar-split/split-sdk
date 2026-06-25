/**
 * Horizon API fallback reader for StellarSplitClient.
 *
 * Wraps @stellar/stellar-sdk's Horizon.Server to provide normalised
 * getAccount / getAccountBalances reads that are compatible with the
 * shapes returned by the Soroban RPC path.  Used as the second link in
 * a FallbackChain when the primary Soroban RPC endpoint is unavailable.
 */

import { Horizon } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Normalised types shared between the RPC path and the Horizon path
// ---------------------------------------------------------------------------

/** Minimal account info — mirrors what Soroban RPC's getAccount returns. */
export interface NormalizedAccount {
  /** Stellar public key (G…). */
  id: string;
  /** Current sequence number as a decimal string. */
  sequence: string;
}

/**
 * Single balance entry normalised across native / issued asset types.
 *
 * - Native XLM: `asset === "native"`
 * - Issued asset: `asset === "CODE:ISSUER"`
 */
export interface NormalizedBalance {
  asset: string;
  balance: string;
}

// ---------------------------------------------------------------------------
// HorizonFallbackReader
// ---------------------------------------------------------------------------

/**
 * Read-only Horizon API client that normalises account and balance responses
 * into shapes compatible with the rest of the StellarSplit SDK.
 *
 * Instantiate once and reuse; Horizon.Server manages its own connection pool.
 */
export class HorizonFallbackReader {
  private readonly _server: Horizon.Server;

  constructor(horizonUrl: string) {
    this._server = new Horizon.Server(horizonUrl);
  }

  /**
   * Fetch account info from Horizon and return a normalised account object.
   *
   * @param address - Stellar public key of the account to look up.
   */
  async getAccount(address: string): Promise<NormalizedAccount> {
    const response = await this._server.loadAccount(address);
    return {
      id: response.id,
      sequence: response.sequenceNumber(),
    };
  }

  /**
   * Fetch all balances for `address` from Horizon and return them in a
   * normalised format.
   *
   * @param address - Stellar public key of the account.
   */
  async getAccountBalances(address: string): Promise<NormalizedBalance[]> {
    const response = await this._server.loadAccount(address);
    return response.balances.map((b) => {
      const asset =
        b.asset_type === "native"
          ? "native"
          : `${"asset_code" in b ? b.asset_code : ""}:${"asset_issuer" in b ? b.asset_issuer : ""}`;
      return { asset, balance: b.balance };
    });
  }
}
