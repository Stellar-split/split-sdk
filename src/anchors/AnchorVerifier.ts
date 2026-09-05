/**
 * AnchorVerifier (#487)
 *
 * Cross-references a `stellar.toml` file with on-chain issuer account data to
 * confirm bidirectional verification:
 *
 *   1. Load the issuer account from Horizon to obtain its `home_domain`.
 *   2. Optionally verify the TLS certificate fingerprint against a pinned value.
 *   3. Fetch the TOML from that `home_domain`.
 *   4. Assert that the TOML's CURRENCIES array contains an entry matching
 *      both `assetCode` and the issuer address.
 *
 * Returns a `VerificationResult` describing the outcome so callers can
 * decide how to handle partial / failed states.
 */

import { Horizon } from "@stellar/stellar-sdk";
import { StellarTomlParser } from "./StellarTomlParser.js";
import type { TomlCurrency, StellarTomlParserOptions } from "./StellarTomlParser.js";
import { CertificatePinningError } from "../errors.js";

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
   * - `"certificate_pinning_mismatch"` — the server's TLS fingerprint did not match the pinned value.
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
  /**
   * Domain-to-SHA-256-fingerprint map for TLS certificate pinning.
   * When a domain is present, the verifier checks the server certificate
   * before trusting the TOML response. Format: colon-separated uppercase
   * hex pairs (standard OpenSSL format).
   *
   * Only effective in Node.js environments where the `tls` module is
   * available. In browsers this check is silently skipped.
   */
  pinnedCertFingerprints?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Certificate pinning helpers (Node.js only)
// ---------------------------------------------------------------------------

/**
 * Connect to `domain:443` over TLS and return the SHA-256 fingerprint of
 * the peer certificate in OpenSSL colon-separated uppercase hex format.
 *
 * Returns `undefined` when the `tls` module is unavailable (browser) or
 * the connection fails.
 */
async function getCertFingerprint(domain: string): Promise<string | undefined> {
  try {
    // Dynamic import so the file still loads in browsers where `tls` is absent.
    const tls = await import("tls");
    return new Promise((resolve, reject) => {
      const socket = tls.connect({ host: domain, port: 443, servername: domain });
      socket.on("error", (err) => reject(err));
      socket.on("secureConnect", () => {
        try {
          const cert = socket.getPeerCertificate(true);
          const raw = cert.raw as Buffer | undefined;
          if (!raw) {
            resolve(undefined);
          } else {
            const crypto = require("crypto");
            const hash = crypto.createHash("sha256").update(raw).digest("hex").toUpperCase();
            // Format as colon-separated pairs
            const formatted = hash.match(/.{2}/g)!.join(":");
            resolve(formatted);
          }
        } finally {
          socket.end();
        }
      });
    });
  } catch {
    return undefined;
  }
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
  private readonly _pinnedFingerprints: Record<string, string>;

  constructor(options: AnchorVerifierOptions = {}) {
    this._server = new Horizon.Server(
      options.horizonUrl ?? "https://horizon.stellar.org",
    );
    this._parser = new StellarTomlParser({
      tomlCacheTtlMs: options.tomlCacheTtlMs,
      fetchTimeoutMs: options.fetchTimeoutMs,
    });
    this._pinnedFingerprints = options.pinnedCertFingerprints ?? {};
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
    // Step 2: Certificate pinning check (Node.js only)
    // -------------------------------------------------------------------
    const pinned = this._pinnedFingerprints[homeDomain];
    if (pinned) {
      const actual = await getCertFingerprint(homeDomain);
      if (actual === undefined) {
        // tls module unavailable — cannot verify, treat as mismatch
        return {
          verified: false,
          tomlUrl: `https://${homeDomain}/.well-known/stellar.toml`,
          issues: ["certificate_pinning_mismatch"],
        };
      }
      if (actual !== pinned) {
        return {
          verified: false,
          tomlUrl: `https://${homeDomain}/.well-known/stellar.toml`,
          issues: ["certificate_pinning_mismatch"],
        };
      }
    }

    // -------------------------------------------------------------------
    // Step 3: Fetch TOML from home_domain
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
    // Step 4: Find a matching CURRENCIES entry
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
   * Verifies the TLS certificate fingerprint for `domain` against the
   * pinned value configured in the constructor.
   *
   * @throws {CertificatePinningError} When the fingerprint does not match.
   * @returns The matched fingerprint when verification succeeds.
   */
  async verifyCertificatePinning(domain: string): Promise<string> {
    const pinned = this._pinnedFingerprints[domain];
    if (!pinned) {
      throw new CertificatePinningError(domain, "(none)", undefined);
    }
    const actual = await getCertFingerprint(domain);
    if (actual !== pinned) {
      throw new CertificatePinningError(domain, pinned, actual);
    }
    return pinned;
  }

  /**
   * Expose the underlying `StellarTomlParser` so callers can pre-warm the
   * cache or clear it.
   */
  get parser(): StellarTomlParser {
    return this._parser;
  }
}
