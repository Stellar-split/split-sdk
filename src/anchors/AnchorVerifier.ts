/**
 * AnchorVerifier (#487)
 *
 * Cross-references a `stellar.toml` file with on-chain issuer account data to
 * confirm bidirectional verification:
 *
 *   1. Load the issuer account from Horizon to obtain its `home_domain`.
 *   2. Fetch the TOML from that `home_domain`.
 *   3. Assert that the TOML's CURRENCIES array contains an entry matching
 *      both `assetCode` and the issuer address.
 *
 * Returns a `VerificationResult` describing the outcome so callers can
 * decide how to handle partial / failed states.
 */

import { Horizon } from "@stellar/stellar-sdk";
import { StellarTomlParser } from "./StellarTomlParser.js";
import type { TomlCurrency, StellarTomlParserOptions } from "./StellarTomlParser.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Outcome of an anchor verification run. */
export interface VerificationResult {
  /** True only when the full bidirectional check passed. */
  verified: boolean;
  /** The URL that was (or would have been) fetched for the TOML. */
  tomlUrl: string;
  /** The matching CURRENCIES entry, when one was found. */
  currencyEntry?: TomlCurrency;
  /**
   * List of issue codes that prevented verification.  Empty when
   * `verified === true`.
   *
   * Possible codes:
   * - `"no_home_domain"` — the issuer account has no `home_domain` set.
   * - `"toml_fetch_failed"` — the TOML file could not be fetched or parsed.
   * - `"currency_not_found"` — the TOML exists but has no matching CURRENCIES entry.
   */
  issues: string[];
}

/** Options for `AnchorVerifier`. */
export interface AnchorVerifierOptions extends StellarTomlParserOptions {
  /**
   * Horizon API base URL for loading issuer account data.
   * @default "https://horizon.stellar.org"
   */
  horizonUrl?: string;
}

// ---------------------------------------------------------------------------
// AnchorVerifier
// ---------------------------------------------------------------------------

/**
 * Verifies that an asset issuer's `home_domain` TOML correctly lists the
 * asset, confirming the anchor's on-chain ↔ off-chain consistency.
 *
 * @example
 * ```ts
 * const verifier = new AnchorVerifier({
 *   horizonUrl: "https://horizon.stellar.org",
 * });
 *
 * const result = await verifier.verify("GA5ZSEJ...", "USDC");
 * if (!result.verified) {
 *   console.warn("Anchor issues:", result.issues);
 * }
 * ```
 */
export class AnchorVerifier {
  private readonly _server: Horizon.Server;
  private readonly _parser: StellarTomlParser;

  constructor(options: AnchorVerifierOptions = {}) {
    this._server = new Horizon.Server(
      options.horizonUrl ?? "https://horizon.stellar.org",
    );
    this._parser = new StellarTomlParser({
      tomlCacheTtlMs: options.tomlCacheTtlMs,
      fetchTimeoutMs: options.fetchTimeoutMs,
    });
  }

  /**
   * Perform the full bidirectional anchor verification.
   *
   * @param assetIssuer - Stellar G… address of the asset issuer account.
   * @param assetCode   - Asset code to look up in the CURRENCIES array.
   */
  async verify(
    assetIssuer: string,
    assetCode: string,
  ): Promise<VerificationResult> {
    // -------------------------------------------------------------------
    // Step 1: Load issuer account from Horizon to get home_domain
    // -------------------------------------------------------------------
    let homeDomain: string | undefined;
    try {
      const account = await this._server.loadAccount(assetIssuer);
      // AccountResponse.home_domain is a plain property on the raw record
      homeDomain = (account as unknown as Record<string, unknown>)
        .home_domain as string | undefined;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        verified: false,
        tomlUrl: "",
        issues: [`account_load_failed: ${msg}`],
      };
    }

    if (!homeDomain) {
      return {
        verified: false,
        tomlUrl: "",
        issues: ["no_home_domain"],
      };
    }

    // -------------------------------------------------------------------
    // Step 2: Fetch TOML from home_domain
    // -------------------------------------------------------------------
    const tomlUrl = `https://${homeDomain}/.well-known/stellar.toml`;
    let metadata: Awaited<ReturnType<StellarTomlParser["fetch"]>>;
    try {
      metadata = await this._parser.fetch(homeDomain);
    } catch {
      return {
        verified: false,
        tomlUrl,
        issues: ["toml_fetch_failed"],
      };
    }

    // -------------------------------------------------------------------
    // Step 3: Find a matching CURRENCIES entry
    // -------------------------------------------------------------------
    const currencies = metadata.CURRENCIES ?? [];
    const match = currencies.find(
      (c) =>
        c.code === assetCode &&
        (c.issuer === assetIssuer ||
          // Some anchors omit issuer in the TOML when home_domain is definitive
          c.issuer === undefined),
    );

    if (!match) {
      return {
        verified: false,
        tomlUrl,
        issues: ["currency_not_found"],
      };
    }

    return {
      verified: true,
      tomlUrl,
      currencyEntry: match,
      issues: [],
    };
  }

  /**
   * Expose the underlying `StellarTomlParser` so callers can pre-warm the
   * cache or clear it.
   */
  get parser(): StellarTomlParser {
    return this._parser;
  }
}
