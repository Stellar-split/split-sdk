/**
 * Account freeze / lock state detector.
 *
 * An issuer can revoke authorization on a trustline (freezing it) or an
 * account can be left in a state where authorization can never be granted
 * again (`AUTH_IMMUTABLE`). Sending payments to or from such accounts fails
 * on submission in ways that are hard to distinguish from other errors.
 * `detectLockState` inspects the recipient's trustline and the issuer's
 * account flags up front so callers can surface a clear error before
 * building a transaction.
 */

import { Asset, Horizon } from "@stellar/stellar-sdk";
import { AccountFrozenError, AccountLockedError } from "./errors.js";
import type { AccountLockState } from "./types.js";

/**
 * Inspect an account's trustline for `asset` and the issuer's account flags
 * to determine whether the account is frozen or permanently locked out of
 * authorization.
 *
 * @param server    - Horizon server instance.
 * @param accountId - Stellar address to inspect.
 * @param asset     - Asset whose trustline is being checked. Native XLM is
 *                    never frozen or locked, so it always returns a fully
 *                    authorized state.
 * @returns The account's lock state.
 */
export async function detectLockState(
  server: Horizon.Server,
  accountId: string,
  asset: Asset,
): Promise<AccountLockState> {
  if (asset.isNative()) {
    return {
      isFrozen: false,
      isLocked: false,
      trustlineAuthorized: true,
      revocableByIssuer: false,
    };
  }

  const account = await server.loadAccount(accountId);
  const balances = account.balances as Array<
    Horizon.HorizonApi.BalanceLineAsset | Horizon.HorizonApi.BalanceLineNative | Horizon.HorizonApi.BalanceLineLiquidityPool
  >;

  const trustline = balances.find(
    (b): b is Horizon.HorizonApi.BalanceLineAsset =>
      (b.asset_type === "credit_alphanum4" || b.asset_type === "credit_alphanum12") &&
      b.asset_code === asset.getCode() &&
      b.asset_issuer === asset.getIssuer(),
  );

  if (!trustline) {
    return {
      isFrozen: false,
      isLocked: false,
      trustlineAuthorized: false,
      reason: "no_trustline",
      revocableByIssuer: false,
    };
  }

  const trustlineAuthorized = trustline.is_authorized;
  const isFrozen = !trustline.is_authorized && !trustline.is_authorized_to_maintain_liabilities;

  let issuerFlags: Horizon.HorizonApi.Flags | undefined;
  try {
    const issuerAccount = await server.loadAccount(asset.getIssuer());
    issuerFlags = issuerAccount.flags;
  } catch {
    issuerFlags = undefined;
  }

  const revocableByIssuer = issuerFlags?.auth_revocable ?? false;
  const isLocked = !trustlineAuthorized && issuerFlags?.auth_immutable === true;

  const result: AccountLockState = {
    isFrozen,
    isLocked,
    trustlineAuthorized,
    revocableByIssuer,
  };
  if (isFrozen) {
    result.reason = "frozen";
  } else if (isLocked) {
    result.reason = "immutable";
  }
  return result;
}

/**
 * Convenience wrapper around {@link detectLockState} that throws when the
 * account is frozen or locked, instead of returning a report.
 *
 * @throws {AccountFrozenError} When the trustline has been frozen by the issuer.
 * @throws {AccountLockedError} When the account can never be authorized again.
 */
export async function assertAccountUnlocked(
  server: Horizon.Server,
  accountId: string,
  asset: Asset,
): Promise<AccountLockState> {
  const state = await detectLockState(server, accountId, asset);
  if (state.isFrozen) {
    throw new AccountFrozenError(accountId, asset.getCode());
  }
  if (state.isLocked) {
    throw new AccountLockedError(accountId, asset.getCode());
  }
  return state;
}
