/**
 * Transaction operation effect aggregator.
 *
 * Fetches all Horizon effects for a submitted transaction and consolidates
 * them into a per-account net asset balance delta summary, so callers get a
 * single "what changed" view instead of raw per-operation effect records.
 */

import type { Horizon } from "@stellar/stellar-sdk";
import type { AccountEffectSummary, AssetDelta } from "./types.js";
import { collectAll } from "./horizonPaginator.js";

/** Effect types that represent a net balance change for an account. */
const CREDIT_EFFECT = "account_credited";
const DEBIT_EFFECT = "account_debited";

/**
 * Convert a Horizon decimal amount string (always 7 fractional digits) to a
 * stroop bigint, without floating-point rounding.
 */
function decimalToStroops(amount: string): bigint {
  const [intPart, fracPart = ""] = amount.split(".");
  const frac = fracPart.padEnd(7, "0").slice(0, 7);
  return BigInt(intPart || "0") * 10_000_000n + BigInt(frac || "0");
}

function effectAssetKey(effect: Record<string, unknown>): string {
  if (effect.asset_type === "native") return "native";
  const code = effect.asset_code as string | undefined;
  const issuer = effect.asset_issuer as string | undefined;
  if (code && issuer) return `${code}:${issuer}`;
  return String(effect.asset_type ?? "unknown");
}

/**
 * Aggregate all effects of a transaction into per-account net asset deltas.
 *
 * Only `account_credited`/`account_debited` effects are counted; intermediate
 * DEX effects (offer creation/removal, trades) are ignored since they net out
 * to the same credited/debited effects on the accounts actually affected.
 *
 * @param server - Horizon server instance.
 * @param txHash - Hash of the transaction to aggregate effects for.
 * @returns One summary per affected account, sorted by account ID.
 */
export async function aggregateEffects(
  server: Horizon.Server,
  txHash: string,
): Promise<AccountEffectSummary[]> {
  const initialPage = await server.effects().forTransaction(txHash).call();
  const effects = await collectAll(initialPage);

  const byAccount = new Map<string, Map<string, bigint>>();

  for (const raw of effects) {
    const effect = raw as unknown as Record<string, unknown>;
    const type = effect.type as string | undefined;
    if (type !== CREDIT_EFFECT && type !== DEBIT_EFFECT) continue;

    const account = effect.account as string | undefined;
    const amount = effect.amount as string | undefined;
    if (!account || amount === undefined) continue;

    const asset = effectAssetKey(effect);
    const stroops = decimalToStroops(amount);
    const signed = type === DEBIT_EFFECT ? -stroops : stroops;

    let assetDeltas = byAccount.get(account);
    if (!assetDeltas) {
      assetDeltas = new Map();
      byAccount.set(account, assetDeltas);
    }
    assetDeltas.set(asset, (assetDeltas.get(asset) ?? 0n) + signed);
  }

  const summaries: AccountEffectSummary[] = [];
  for (const accountId of Array.from(byAccount.keys()).sort()) {
    const assetDeltas: AssetDelta[] = Array.from(byAccount.get(accountId)!.entries())
      .filter(([, delta]) => delta !== 0n)
      .map(([asset, delta]) => ({ asset, delta }));
    if (assetDeltas.length > 0) {
      summaries.push({ accountId, assetDeltas });
    }
  }

  return summaries;
}
