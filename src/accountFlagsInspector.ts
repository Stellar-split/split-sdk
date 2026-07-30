/**
 * Account Flags State Inspector — decodes the AUTH_* flags on a Stellar
 * account's Horizon `AccountRecord` into a typed `AccountFlagSet`, so callers
 * don't need to inspect Horizon's raw `flags` object themselves.
 */

import { Horizon } from "@stellar/stellar-sdk";
import type { AccountFlagSet } from "./types.js";

/** Operations that AUTH_REQUIRED blocks until the holder has been explicitly authorized. */
const AUTH_REQUIRED_BLOCKS = new Set(["trustline", "create_trustline", "payment"]);

function buildFlagSet(flags: Horizon.HorizonApi.Flags): AccountFlagSet {
  const flagSet: AccountFlagSet = {
    authRequired: flags.auth_required,
    authRevocable: flags.auth_revocable,
    authImmutable: flags.auth_immutable,
    authClawbackEnabled: flags.auth_clawback_enabled,
    isCompatibleWith(operation: string): boolean {
      if (flagSet.authRequired && AUTH_REQUIRED_BLOCKS.has(operation.toLowerCase())) {
        return false;
      }
      return true;
    },
  };
  return flagSet;
}

/**
 * Fetch and decode the AUTH_* flags for a Stellar account.
 *
 * @param accountId  - Stellar address to inspect.
 * @param horizonUrl - Horizon API base URL used to load the account.
 */
export async function inspectFlags(
  accountId: string,
  horizonUrl: string,
): Promise<AccountFlagSet> {
  const server = new Horizon.Server(horizonUrl);
  const account = await server.loadAccount(accountId);
  return buildFlagSet(account.flags);
}

/**
 * Convenience quick-fail check: `true` when any flag that can restrict a
 * counterparty's ability to hold or transact in this account's asset is set
 * (`authRequired`, `authRevocable`, or `authClawbackEnabled`).
 *
 * `authImmutable` is excluded — it only affects whether the issuer's own
 * flags can change in the future, not a counterparty's current operations.
 */
export function hasAnyRestrictiveFlag(flags: AccountFlagSet): boolean {
  return flags.authRequired || flags.authRevocable || flags.authClawbackEnabled;
}
