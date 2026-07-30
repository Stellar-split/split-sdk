/**
 * Cross-asset price oracle for settlement calculations (invoice normalisation,
 * multi-asset line items). Unlike `currencyConverter.ts` (display-only, never
 * feeds into real amounts), rates returned here are used to compute amounts
 * that settle on-chain, so callers should treat failures as fatal rather than
 * falling back to a stale/cached display value.
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

/** Resolves a conversion rate between two on-chain assets. */
export interface PriceOracle {
  /**
   * Fixed-point rate (1e18 = 1.0) to convert 1 unit of `fromAsset` into
   * `toAsset`, or `undefined` when no price is available for that pair.
   */
  getRate(fromAsset: string, toAsset: string): Promise<bigint | undefined>;
}

/** Soroban contract-backed price oracle. */
export class ContractPriceOracle implements PriceOracle {
  constructor(
    private readonly server: SorobanRpc.Server,
    private readonly oracleAddress: string,
    private readonly networkPassphrase: string
  ) {}

  async getRate(fromAsset: string, toAsset: string): Promise<bigint | undefined> {
    const contract = new Contract(this.oracleAddress);
    const operation = contract.call(
      "get_price",
      nativeToScVal(fromAsset, { type: "symbol" }),
      nativeToScVal(toAsset, { type: "symbol" })
    );

    const sourceAccount = {
      accountId: () => this.oracleAddress,
      sequenceNumber: () => "0",
      incrementSequenceNumber: () => {},
    } as any;

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simResult = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      if (/no price|not found|unsupported/i.test(simResult.error)) {
        return undefined;
      }
      throw new OraclePriceError(`Oracle simulation failed: ${simResult.error}`);
    }

    const returnVal = (simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).result
      ?.retval;
    if (!returnVal) throw new NoReturnValueError("oracle get_price");

    return BigInt(scValToNative(returnVal));
  }
}
