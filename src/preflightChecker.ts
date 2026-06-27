import { rpc as SorobanRpc } from "@stellar/stellar-sdk";

export type PayerReadinessReason =
  | "account_not_found"
  | "insufficient_balance"
  | "no_trustline";

export interface PayerReadinessResult {
  ready: boolean;
  reason?: PayerReadinessReason;
}

/**
 * Checks whether a payer account is ready to fund an invoice.
 *
 * Verifies the account exists on-chain, holds a trustline for the required
 * token, and has sufficient balance to cover the required amount.
 *
 * @param server         - Soroban RPC server instance.
 * @param address        - Stellar address of the payer.
 * @param requiredAmount - Amount needed in the token's base unit (as a bigint of stroops).
 * @param token          - Token contract address (or "native" for XLM).
 * @returns Readiness result with an optional failure reason.
 */
export async function checkPayerReadiness(
  server: SorobanRpc.Server,
  address: string,
  requiredAmount: bigint,
  token: string,
): Promise<PayerReadinessResult> {
  let account: Awaited<ReturnType<SorobanRpc.Server["getAccount"]>>;
  try {
    account = await server.getAccount(address);
  } catch {
    return { ready: false, reason: "account_not_found" };
  }

  const isNative = token === "native";
  const balances = account.balances as Array<{
    balance: string;
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
    liquidity_pool_id?: string;
  }>;

  if (isNative) {
    const nativeBalance = balances.find((b) => b.asset_type === "native");
    if (!nativeBalance) {
      return { ready: false, reason: "no_trustline" };
    }
    const balanceStroops = BigInt(Math.round(parseFloat(nativeBalance.balance) * 1_000_000_0));
    if (balanceStroops < requiredAmount) {
      return { ready: false, reason: "insufficient_balance" };
    }
    return { ready: true };
  }

  // For non-native tokens, find a balance entry matching the contract/issuer address.
  // Trustline is identified by asset_issuer matching the token address.
  const tokenBalance = balances.find(
    (b) =>
      b.asset_type !== "native" &&
      b.asset_type !== "liquidity_pool_shares" &&
      b.asset_issuer === token,
  );

  if (!tokenBalance) {
    return { ready: false, reason: "no_trustline" };
  }

  const balanceUnits = BigInt(Math.round(parseFloat(tokenBalance.balance) * 1_000_000_0));
  if (balanceUnits < requiredAmount) {
    return { ready: false, reason: "insufficient_balance" };
  }

  return { ready: true };
}
