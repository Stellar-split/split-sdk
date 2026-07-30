/**
 * Multi-asset invoice line item normaliser.
 *
 * Resolves every line item to the invoice's settlement asset using a
 * `PriceOracle`, so an invoice mixing e.g. USDC and XLM line items can be
 * presented and persisted as a single normalised total.
 */

import type { InvoiceLineItem, NormalizedInvoiceTotal, NormalizedLineItem } from "./types.js";
import type { PriceOracle } from "./priceOracle.js";
import { UnsupportedLineItemAssetError } from "./errors.js";

/** Fixed-point scale used for conversion rates (1e18 = 1.0). */
const RATE_SCALE = 1_000_000_000_000_000_000n;

/**
 * Normalise a set of line items to a single settlement asset.
 *
 * Same-asset items pass through without an oracle call. Cross-asset items
 * are converted using `oracle.getRate`, called at most once per unique
 * (asset, settlementAsset) pair. Zero-amount items (discounts, waivers) never
 * trigger an oracle call.
 *
 * @param items - Line items, each denominated in its own asset.
 * @param settlementAsset - Asset identifier to normalise all amounts to.
 * @param oracle - Price oracle used for cross-asset conversion.
 * @throws {UnsupportedLineItemAssetError} When a line item's asset has no oracle price available.
 */
export async function normalizeLineItems(
  items: InvoiceLineItem[],
  settlementAsset: string,
  oracle: PriceOracle
): Promise<NormalizedInvoiceTotal> {
  const rateCache = new Map<string, bigint>();
  const normalizedItems: NormalizedLineItem[] = [];
  let total = 0n;

  for (const item of items) {
    const originalAmount = item.total ?? item.unitPrice * BigInt(item.quantity);

    if (originalAmount === 0n) {
      normalizedItems.push({
        description: item.description,
        originalAmount,
        originalAsset: item.asset,
        convertedAmount: 0n,
        conversionRate: RATE_SCALE,
      });
      continue;
    }

    if (item.asset === settlementAsset) {
      normalizedItems.push({
        description: item.description,
        originalAmount,
        originalAsset: item.asset,
        convertedAmount: originalAmount,
        conversionRate: RATE_SCALE,
      });
      total += originalAmount;
      continue;
    }

    let rate = rateCache.get(item.asset);
    if (rate === undefined) {
      const fetched = await oracle.getRate(item.asset, settlementAsset);
      if (fetched === undefined) {
        throw new UnsupportedLineItemAssetError(item.asset);
      }
      rate = fetched;
      rateCache.set(item.asset, rate);
    }

    const convertedAmount = (originalAmount * rate) / RATE_SCALE;
    normalizedItems.push({
      description: item.description,
      originalAmount,
      originalAsset: item.asset,
      convertedAmount,
      conversionRate: rate,
    });
    total += convertedAmount;
  }

  return { settlementAsset, total, items: normalizedItems };
}
