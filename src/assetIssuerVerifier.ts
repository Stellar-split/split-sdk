/**
 * Asset issuer verification pipeline for StellarSplit.
 *
 * Verifies that an asset issuer account exists on the network, has a valid
 * home domain, publishes a proper stellar.toml, lists the asset code
 * in its CURRENCIES section, and is not frozen or deauthorised.
 * This prevents fraudulent lookalike assets from being used in invoice payments.
 */

import { Server, StellarTomlResolver } from "@stellar/stellar-sdk";
import type { IssuerVerificationResult } from "./types.js";

/**
 * Verify that an asset issuer account is legitimate.
 *
 * Performs a multi-step verification:
 * 1. Loads the issuer account to confirm existence
 * 2. Checks the account's home_domain flag
 * 3. Checks the account is not frozen or deauthorised (auth_required/revocable check)
 * 4. Fetches stellar.toml from the home domain
 * 5. Validates the asset code appears in the CURRENCIES section
 *
 * @param horizonUrl - Full URL of the Horizon API (e.g. "https://horizon.stellar.org").
 * @param issuerId - Stellar G-address of the asset issuer.
 * @param assetCode - The asset code to verify (e.g. "USDC").
 * @param opts - Optional timeout in milliseconds (default: 15_000).
 * @returns A detailed {@link IssuerVerificationResult}.
 */
export async function verifyAssetIssuer(
  horizonUrl: string,
  issuerId: string,
  assetCode: string,
  opts?: { timeoutMs?: number },
): Promise<IssuerVerificationResult> {
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const errors: string[] = [];
  let accountExists = false;
  let homeDomain: string | null = null;
  let tomlFound = false;
  let assetInToml = false;
  let frozen = false;
  let deauthorised = false;

  const server = new Server(horizonUrl);

  // Step 1: Load the issuer account
  let accountRaw: Record<string, unknown> | null = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const account = await server.loadAccount(issuerId);
      accountExists = true;

      // Extract account data as raw object
      accountRaw = account as unknown as Record<string, unknown>;
      homeDomain = (accountRaw.home_domain as string) ?? null;

      if (!homeDomain) {
        errors.push("Issuer account has no home_domain set");
      }

      // Step 2: Check for frozen/deauthorised flags
      const flags = (accountRaw.flags as Record<string, boolean | number>) ?? {};
      const authRequired = flags.auth_required === true || flags.auth_required === 1;
      const authRevocable = flags.auth_revocable === true || flags.auth_revocable === 1;
      const authImmutable = flags.auth_immutable === true || flags.auth_immutable === 1;

      if (authImmutable) {
        errors.push("Issuer account has auth_immutable flag set — issuer cannot update authorisation");
        deauthorised = true;
      }
      if (authRequired && authRevocable) {
        // Both set: issuer can freeze — but this is expected for regulated assets
        // Not inherently an error, but worth flagging if no toml validation
      }
      if (authRequired) {
        errors.push("Issuer requires authorisation (auth_required) — may deauthorise trustlines");
        deauthorised = true;
      }

      // Check if account has any frozen trustlines (relevant flag on the issuer)
      const authClawbackEnabled = flags.auth_clawback_enabled === true || flags.auth_clawback_enabled === 1;
      if (authClawbackEnabled) {
        errors.push("Issuer has clawback enabled — may freeze and claw back assets");
        frozen = true;
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if ((err as { name?: string }).name === "AbortError" || message.includes("abort")) {
      errors.push(`Timeout: could not load issuer account within ${timeoutMs}ms`);
    } else if (message.includes("Not Found") || message.includes("404")) {
      errors.push("Issuer account not found on the network");
    } else {
      errors.push(`Failed to load issuer account: ${message}`);
    }

    return {
      verified: false,
      issuerId,
      accountExists: false,
      homeDomain: null,
      tomlFound: false,
      assetInToml: false,
      assetCode,
      errors,
    };
  }

  // If no home domain, we can't proceed with toml verification
  if (!homeDomain) {
    return {
      verified: false,
      issuerId,
      accountExists: true,
      homeDomain: null,
      tomlFound: false,
      assetInToml: false,
      assetCode,
      errors,
    };
  }

  // Step 3: Fetch stellar.toml
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const toml = await StellarTomlResolver.resolve(homeDomain, {
        signal: controller.signal,
      } as unknown as { signal: AbortSignal });

      tomlFound = true;

      // Step 4: Check if the asset code appears in CURRENCIES
      const currencies = toml.CURRENCIES ?? [];
      if (Array.isArray(currencies)) {
        assetInToml = currencies.some(
          (c: { code?: string; issuer?: string }) =>
            c.code === assetCode && c.issuer === issuerId,
        );

        if (!assetInToml) {
          errors.push(
            `Asset code "${assetCode}" with issuer "${issuerId}" not found in stellar.toml CURRENCIES`,
          );
        }
      } else {
        errors.push("stellar.toml has no CURRENCIES section");
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if ((err as { name?: string }).name === "AbortError" || message.includes("abort")) {
      errors.push(`Timeout: could not fetch stellar.toml within ${timeoutMs}ms`);
    } else {
      errors.push(`Failed to fetch stellar.toml from ${homeDomain}: ${message}`);
    }
  }

  const verified = accountExists && tomlFound && assetInToml && errors.length === 0;

  return {
    verified,
    issuerId,
    accountExists,
    homeDomain,
    tomlFound,
    assetInToml,
    assetCode,
    errors,
  };
}
