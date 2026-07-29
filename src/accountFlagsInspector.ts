/**
 * Account authorization flag inspector for StellarSplit.
 *
 * Reads an account's `AUTH_REQUIRED` / `AUTH_REVOCABLE` / `AUTH_IMMUTABLE` /
 * `AUTH_CLAWBACK_ENABLED` flags via Horizon. Used by
 * {@link ./trustlineAuthHandler.js} to detect when an issuer must explicitly
 * approve a recipient's trustline before they can hold the asset.
 */

import type { Horizon } from "@stellar/stellar-sdk";

/** Authorization flags for a Stellar account. */
export interface AccountFlagsResult {
  /** Stellar address the flags were read from. */
  accountId: string;
  /** Issuer must approve each trustline before it can hold the asset. */
  authRequired: boolean;
  /** Issuer can revoke authorization on an existing trustline. */
  authRevocable: boolean;
  /** Authorization flags are permanently fixed and can never change. */
  authImmutable: boolean;
  /** Issuer can claw back the asset from any trustline. */
  authClawbackEnabled: boolean;
}

/**
 * Inspect the authorization flags on an account (typically an asset issuer).
 *
 * @param server    - Horizon server instance.
 * @param accountId - Stellar address to inspect.
 * @returns The account's authorization flags. All flags are `false` when the
 *          account cannot be loaded (e.g. it does not exist on-chain).
 */
export async function inspectAccountFlags(
  server: Horizon.Server,
  accountId: string,
): Promise<AccountFlagsResult> {
  try {
    const account = await server.loadAccount(accountId);
    const flags = (account as unknown as { flags: Record<string, boolean> }).flags ?? {};
    return {
      accountId,
      authRequired: Boolean(flags.auth_required),
      authRevocable: Boolean(flags.auth_revocable),
      authImmutable: Boolean(flags.auth_immutable),
      authClawbackEnabled: Boolean(flags.auth_clawback_enabled),
    };
  } catch {
    return {
      accountId,
      authRequired: false,
      authRevocable: false,
      authImmutable: false,
      authClawbackEnabled: false,
    };
  }
}
