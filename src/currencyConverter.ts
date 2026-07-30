/**
 * Display-only currency converter using the contract's price oracle.
 *
 * This module is purely for UI display purposes — it does NOT affect
 * payment amounts or interact with pay() calculations.
 */

import {
  Contract,
  rpc as SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";
import { OraclePriceError, NoReturnValueError } from "./errors.js";
import { RateCache } from "./rateCache.js";

export interface ConvertedAmount {
  original: bigint;
  converted: bigint;
  rate: bigint;
  fromToken: string;
  toDisplayCurrency: string;
}

const DEFAULT_CACHE_TTL_MS = 10_000;

/** One `RateCache<bigint>` per oracle address, so entries survive across calls. */
const rateCachesByOracle = new Map<string, RateCache<bigint>>();

function getRateCache(
  oracleAddress: string,
  server: SorobanRpc.Server,
  networkPassphrase: string,
  ttlMs: number,
): RateCache<bigint> {
  let cache = rateCachesByOracle.get(oracleAddress);
  if (!cache) {
    cache = new RateCache<bigint>(
      (from, to) => fetchOraclePrice(from, to, oracleAddress, server, networkPassphrase),
      { ttlMs },
    );
    rateCachesByOracle.set(oracleAddress, cache);
  }
  return cache;
}

export function clearPriceCache(): void {
  for (const cache of rateCachesByOracle.values()) {
    cache.stop();
    cache.invalidateAll();
  }
  rateCachesByOracle.clear();
}

async function fetchOraclePrice(
  fromToken: string,
  toDisplayCurrency: string,
  oracleAddress: string,
  server: SorobanRpc.Server,
  networkPassphrase: string,
): Promise<bigint> {
  const contract = new Contract(oracleAddress);
  const operation = contract.call(
    "get_price",
    nativeToScVal(fromToken, { type: "symbol" }),
    nativeToScVal(toDisplayCurrency, { type: "symbol" }),
  );

  const sourceAccount = {
    accountId: () => oracleAddress,
    sequenceNumber: () => "0",
    incrementSequenceNumber: () => {},
  } as any;

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();

  const simResult = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(simResult)) {
    throw new OraclePriceError(`Oracle simulation failed: ${simResult.error}`);
  }

  const returnVal = (simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  if (!returnVal) throw new NoReturnValueError("oracle get_price");

  return BigInt(scValToNative(returnVal));
}

export async function convertAmount(
  amount: bigint,
  fromToken: string,
  toDisplayCurrency: string,
  oracleAddress: string,
  server: SorobanRpc.Server,
  networkPassphrase: string,
  priceCacheTtlMs: number = DEFAULT_CACHE_TTL_MS,
): Promise<ConvertedAmount> {
  const cache = getRateCache(oracleAddress, server, networkPassphrase, priceCacheTtlMs);
  const rate = await cache.getRate(fromToken, toDisplayCurrency);

  // rate is assumed to be in fixed-point with 18 decimals (1e18 = 1.0)
  const converted = (amount * rate) / 1_000_000_000_000_000_000n;

  return {
    original: amount,
    converted,
    rate,
    fromToken,
    toDisplayCurrency,
  };
}

/** Result of converting a fiat-denominated invoice amount to an on-chain asset. */
export interface FiatConversion {
  /** The requested fiat amount. */
  fiatAmount: number;
  /** The fiat currency code the amount was denominated in (e.g. "USD"). */
  fiatCurrency: string;
  /** The equivalent amount in the target asset. */
  assetAmount: number;
  /** The asset code the amount was converted to (e.g. "XLM"). */
  assetCode: string;
  /** The base/quote rate used for the conversion (units of `fiatCurrency` per 1 `assetCode`). */
  rate: number;
}

/**
 * Convert a fiat-denominated amount into its equivalent in `assetCode` using
 * a pluggable {@link PriceOracleAdapter} (see priceOracle.ts for the default
 * CoinGecko-backed implementation). Display-only, like the rest of this module.
 */
export async function convertFiatToAsset(
  fiatAmount: number,
  fiatCurrency: string,
  assetCode: string,
  oracle: PriceOracleAdapter,
): Promise<FiatConversion> {
  const rate = await oracle.getPrice(assetCode, fiatCurrency);
  if (!(rate > 0)) {
    throw new OraclePriceError(`Invalid oracle rate for ${assetCode}/${fiatCurrency}: ${rate}`);
  }

  return {
    fiatAmount,
    fiatCurrency,
    assetAmount: fiatAmount / rate,
    assetCode,
    rate,
  };
}