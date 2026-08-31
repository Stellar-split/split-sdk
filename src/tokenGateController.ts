/**
 * Token-Gated Invoice Access Controller
 *
 * Verifies that a caller holds the minimum balance of a specific Stellar asset
 * before granting access to an invoice. Balance checks are cached with a short
 * TTL to reduce Horizon calls.
 *
 * Integrates with src/client.ts getInvoice() and src/accessControl.ts.
 */

import { Horizon } from "@stellar/stellar-sdk";
import type { TokenGatePolicy } from "./types.js";
import { TokenGateAccessDeniedError } from "./errors.js";
import { SimpleCache } from "./cache.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for creating a {@link TokenGateController}. */
export interface TokenGateControllerOptions {
  /**
   * Base URL for the Horizon server used to load account balances.
   * @example "https://horizon-testnet.stellar.org"
   */
  horizonUrl: string;
  /**
   * How long (in milliseconds) to cache a balance check result.
   * @default 15_000
   */
  cacheTtlMs?: number;
}

/** The result of a successful balance verification. */
export interface TokenGateVerifyResult {
  /** Whether the caller meets the balance requirement. */
  allowed: boolean;
  /** The caller's current balance of the required asset. */
  actualBalance: string;
  /** The required minimum balance. */
  requiredBalance: string;
  /** Whether the result was served from the cache. */
  cached: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse a balance string like "123.4500000" to a comparable number.
 * Stellar balances have up to 7 decimal places.
 */
function parseBalance(b: string): number {
  return parseFloat(b);
}

/** Build the cache key for a given caller + policy combination. */
function cacheKey(callerAccountId: string, policy: TokenGatePolicy): string {
  return `token-gate:${callerAccountId}:${policy.asset}`;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * Verifies that a caller holds the minimum balance of a specific Stellar asset
 * before granting access to an invoice.
 *
 * @example
 * ```typescript
 * const controller = new TokenGateController({
 *   horizonUrl: "https://horizon-testnet.stellar.org",
 * });
 *
 * const policy: TokenGatePolicy = {
 *   asset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
 *   minBalance: "10.0000000",
 * };
 *
 * // Resolves if caller has >= 10 USDC, throws TokenGateAccessDeniedError otherwise.
 * await controller.verify("G...", policy);
 * ```
 */
export class TokenGateController {
  private readonly horizonUrl: string;
  private readonly cacheTtlMs: number;
  private readonly _cache: SimpleCache<TokenGateVerifyResult>;

  constructor(options: TokenGateControllerOptions) {
    this.horizonUrl = options.horizonUrl.replace(/\/$/, "");
    this.cacheTtlMs = options.cacheTtlMs ?? 15_000;

    // Use SimpleCache with a default TTL
    this._cache = new SimpleCache<TokenGateVerifyResult>({
      enabled: true,
      ttlMs: this.cacheTtlMs,
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Verify that `callerAccountId` holds at least `policy.minBalance` of
   * `policy.asset`.
   *
   * - Resolves with a {@link TokenGateVerifyResult} when the caller meets the
   *   requirement.
   * - Throws {@link TokenGateAccessDeniedError} when `policy.strict !== false`
   *   and the balance is insufficient **or** the current time is outside the
   *   gate's `validFrom`/`validUntil` window.
   * - When `policy.strict === false`, logs a warning and resolves instead of
   *   throwing.
   * - When `validFrom` and/or `validUntil` are provided, the gate returns
   *   `allowed: false` outside that window regardless of the caller's balance.
   * - When no time constraints are set the gate evaluates balance only (no
   *   behavior change).
   *
   * @param callerAccountId - The Stellar public key (G…) of the caller.
   * @param policy          - The token-gate policy to evaluate.
   */
  async verify(
    callerAccountId: string,
    policy: TokenGatePolicy,
  ): Promise<TokenGateVerifyResult> {
    const strict = policy.strict !== false; // default true
    const assetCode = policy.asset.split(":")[0] ?? policy.asset;

    // ── Time-window check ──────────────────────────────────────────────────
    // Evaluate before the cache so that time boundaries are always respected
    // even for cached results.
    const now = new Date();
    if (policy.validFrom !== undefined && now < policy.validFrom) {
      const result: TokenGateVerifyResult = {
        allowed: false,
        actualBalance: "0.0000000",
        requiredBalance: policy.minBalance,
        cached: false,
      };
      if (strict) {
        throw new TokenGateAccessDeniedError(
          callerAccountId,
          assetCode,
          policy.minBalance,
          result.actualBalance,
        );
      } else {
        console.warn(
          `[TokenGateController] Non-strict warning: gate for ${assetCode} not yet active ` +
            `(validFrom: ${policy.validFrom.toISOString()}).`,
        );
      }
      return result;
    }
    if (policy.validUntil !== undefined && now > policy.validUntil) {
      const result: TokenGateVerifyResult = {
        allowed: false,
        actualBalance: "0.0000000",
        requiredBalance: policy.minBalance,
        cached: false,
      };
      if (strict) {
        throw new TokenGateAccessDeniedError(
          callerAccountId,
          assetCode,
          policy.minBalance,
          result.actualBalance,
        );
      } else {
        console.warn(
          `[TokenGateController] Non-strict warning: gate for ${assetCode} has expired ` +
            `(validUntil: ${policy.validUntil.toISOString()}).`,
        );
      }
      return result;
    }

    // ── Cache check ────────────────────────────────────────────────────────
    const key = cacheKey(callerAccountId, policy);
    const cached = this._cache.get(key);
    if (cached !== undefined) {
      if (!cached.allowed && strict) {
        throw new TokenGateAccessDeniedError(
          callerAccountId,
          assetCode,
          policy.minBalance,
          cached.actualBalance,
        );
      }
      return { ...cached, cached: true };
    }

    // ── Balance check ──────────────────────────────────────────────────────
    const balance = await this._fetchBalance(callerAccountId, policy.asset);

    const allowed = parseBalance(balance) >= parseBalance(policy.minBalance);

    const result: TokenGateVerifyResult = {
      allowed,
      actualBalance: balance,
      requiredBalance: policy.minBalance,
      cached: false,
    };

    // Cache regardless of pass/fail so repeated checks within the TTL window
    // don't hammer Horizon.
    this._cache.set(key, result);

    if (!allowed) {
      if (strict) {
        throw new TokenGateAccessDeniedError(
          callerAccountId,
          assetCode,
          policy.minBalance,
          balance,
        );
      } else {
        console.warn(
          `[TokenGateController] Non-strict warning: ${callerAccountId} has ${balance} ${assetCode} ` +
            `(required ${policy.minBalance}). Access allowed in non-strict mode.`,
        );
      }
    }

    return result;
  }

  /**
   * Invalidate cached balance data for a specific caller and asset.
   *
   * @param callerAccountId - Caller whose cache entry should be invalidated.
   * @param policy          - Policy used as the cache key.
   */
  invalidateCache(callerAccountId: string, policy: TokenGatePolicy): void {
    const key = cacheKey(callerAccountId, policy);
    this._cache.invalidate(key);
  }

  /**
   * Clear all cached balance check results.
   */
  clearCache(): void {
    this._cache.clear();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Load the caller's account from Horizon and extract the balance for the
   * specified asset.
   *
   * @param accountId  - Stellar account public key.
   * @param asset      - "CODE:ISSUER" string, or "native" for XLM.
   * @returns Balance as a decimal string (e.g. "42.5000000"), or "0.0000000"
   *          if the account has no trustline for the asset.
   */
  async _fetchBalance(accountId: string, asset: string): Promise<string> {
    const server = new Horizon.Server(this.horizonUrl, {
      allowHttp: this.horizonUrl.startsWith("http://"),
    });

    const account = await server.loadAccount(accountId);

    if (asset === "native" || asset.toUpperCase() === "XLM") {
      const nativeBalance = account.balances.find(
        (b: { asset_type: string }) => b.asset_type === "native",
      ) as { balance: string } | undefined;
      return nativeBalance?.balance ?? "0.0000000";
    }

    const [assetCode, assetIssuer] = asset.split(":");
    const found = account.balances.find(
      (b: { asset_type: string; asset_code?: string; asset_issuer?: string }) =>
        b.asset_type === "credit_alphanum4" ||
        b.asset_type === "credit_alphanum12"
          ? b.asset_code === assetCode && b.asset_issuer === assetIssuer
          : false,
    ) as { balance: string } | undefined;

    return found?.balance ?? "0.0000000";
  }
}
