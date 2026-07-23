/**
 * SEP-41 fungible token interface adapter for StellarSplit.
 *
 * Normalises balance/transfer/approve/allowance calls across SEP-41-compliant
 * and legacy Soroban token contracts.  Methods that the underlying contract
 * does not implement are detected via simulation probing; callers receive
 * `null` and a warning rather than an uncaught error.
 */

import {
  Account,
  Contract,
  TransactionBuilder,
  rpc as SorobanRpc,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { Sep41AdapterError, NoReturnValueError } from "./errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which SEP-41 methods the underlying contract exposes. */
export interface Sep41TokenCapabilities {
  hasBalance: boolean;
  hasTransfer: boolean;
  hasTransferFrom: boolean;
  hasApprove: boolean;
  hasAllowance: boolean;
}

// ---------------------------------------------------------------------------
// Sep41Adapter
// ---------------------------------------------------------------------------

/**
 * Thin adapter that wraps a Soroban token contract and normalises calls to the
 * five SEP-41 methods: balance, transfer, transfer_from, approve, allowance.
 *
 * Construction is cheap — capability probing is lazy and cached on first use.
 */
export class Sep41Adapter {
  private readonly _contract: Contract;
  private readonly _server: SorobanRpc.Server;
  private readonly _networkPassphrase: string;
  private readonly _sourceAccount: string;
  private _capabilities: Sep41TokenCapabilities | null = null;

  constructor(
    tokenAddress: string,
    server: SorobanRpc.Server,
    networkPassphrase: string,
    /** Any valid Stellar public key to use as the simulation source. */
    sourceAccount: string
  ) {
    this._contract = new Contract(tokenAddress);
    this._server = server;
    this._networkPassphrase = networkPassphrase;
    this._sourceAccount = sourceAccount;
  }

  // -------------------------------------------------------------------------
  // Capability probing
  // -------------------------------------------------------------------------

  /**
   * Probe a single method name by simulating a call with no arguments.
   *
   * FunctionNotFound / MissingValue → method absent (false).
   * Any other simulation error (e.g. argument-type error) → method exists (true).
   */
  private async _probeMethod(method: string): Promise<boolean> {
    try {
      const account = new Account(this._sourceAccount, "0");
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this._networkPassphrase,
      })
        .addOperation(this._contract.call(method))
        .setTimeout(30)
        .build();

      const simResult = await this._server.simulateTransaction(tx);

      if (SorobanRpc.Api.isSimulationError(simResult)) {
        const errMsg =
          typeof simResult.error === "string"
            ? simResult.error
            : JSON.stringify(simResult.error);
        // A missing-method error means the contract doesn't have this fn.
        if (
          errMsg.includes("FunctionNotFound") ||
          errMsg.includes("MissingValue")
        ) {
          return false;
        }
        // Any other simulation error (e.g. wrong arg count) still means the
        // method exists; the contract just didn't like our empty call.
        return true;
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Lazily probe and cache the capabilities of the underlying token contract.
   * Subsequent calls return the cached result without additional RPC calls.
   */
  async getCapabilities(): Promise<Sep41TokenCapabilities> {
    if (this._capabilities) return this._capabilities;

    const [
      hasBalance,
      hasTransfer,
      hasTransferFrom,
      hasApprove,
      hasAllowance,
    ] = await Promise.all([
      this._probeMethod("balance"),
      this._probeMethod("transfer"),
      this._probeMethod("transfer_from"),
      this._probeMethod("approve"),
      this._probeMethod("allowance"),
    ]);

    this._capabilities = {
      hasBalance,
      hasTransfer,
      hasTransferFrom,
      hasApprove,
      hasAllowance,
    };

    return this._capabilities;
  }

  // -------------------------------------------------------------------------
  // Internal simulation helper
  // -------------------------------------------------------------------------

  private async _simulateView(operation: xdr.Operation): Promise<unknown> {
    const account = new Account(this._sourceAccount, "0");
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this._networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simResult = await this._server.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Sep41AdapterError(
        typeof simResult.error === "string"
          ? simResult.error
          : JSON.stringify(simResult.error)
      );
    }

    const retval = (
      simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse
    ).result?.retval;
    if (!retval) return null;
    return scValToNative(retval);
  }

  // -------------------------------------------------------------------------
  // SEP-41 interface
  // -------------------------------------------------------------------------

  /**
   * Query the token balance for `account`.
   */
  async balance(account: string): Promise<bigint> {
    const op = this._contract.call(
      "balance",
      nativeToScVal(account, { type: "address" })
    );
    const result = await this._simulateView(op);
    if (typeof result === "bigint") return result;
    if (typeof result === "number" || typeof result === "string") {
      return BigInt(result);
    }
    throw new Sep41AdapterError("Unexpected return type from 'balance'");
  }

  /**
   * Build a `transfer` operation.
   *
   * The returned `xdr.Operation` should be submitted via the client's normal
   * transaction pipeline.
   */
  transfer(from: string, to: string, amount: bigint): xdr.Operation {
    return this._contract.call(
      "transfer",
      nativeToScVal(from, { type: "address" }),
      nativeToScVal(to, { type: "address" }),
      nativeToScVal(amount, { type: "i128" })
    );
  }

  /**
   * Build a `transfer_from` operation (spender-initiated delegated transfer).
   *
   * The returned `xdr.Operation` should be submitted via the client's normal
   * transaction pipeline.
   */
  transferFrom(
    spender: string,
    from: string,
    to: string,
    amount: bigint
  ): xdr.Operation {
    return this._contract.call(
      "transfer_from",
      nativeToScVal(spender, { type: "address" }),
      nativeToScVal(from, { type: "address" }),
      nativeToScVal(to, { type: "address" }),
      nativeToScVal(amount, { type: "i128" })
    );
  }

  /**
   * Build an `approve` operation granting `spender` an allowance of `amount`
   * on behalf of `from`.
   *
   * Returns `null` if the underlying contract does not implement `approve`.
   * A warning is logged in that case.
   *
   * @param expirationLedger - Ledger sequence number at which the approval
   *   expires (defaults to 0, meaning no expiration in legacy contracts that
   *   accept the field but ignore it).
   */
  async approve(
    from: string,
    spender: string,
    amount: bigint,
    expirationLedger = 0
  ): Promise<xdr.Operation | null> {
    const caps = await this.getCapabilities();
    if (!caps.hasApprove) {
      console.warn(
        "[Sep41Adapter] Token contract does not implement 'approve'; treating as unsupported"
      );
      return null;
    }
    return this._contract.call(
      "approve",
      nativeToScVal(from, { type: "address" }),
      nativeToScVal(spender, { type: "address" }),
      nativeToScVal(amount, { type: "i128" }),
      nativeToScVal(expirationLedger, { type: "u32" })
    );
  }

  /**
   * Query the allowance that `owner` has granted to `spender`.
   *
   * Returns `null` if the underlying contract does not implement `allowance`.
   * A warning is logged in that case.
   */
  async allowance(owner: string, spender: string): Promise<bigint | null> {
    const caps = await this.getCapabilities();
    if (!caps.hasAllowance) {
      console.warn(
        "[Sep41Adapter] Token contract does not implement 'allowance'; treating as unsupported"
      );
      return null;
    }
    const op = this._contract.call(
      "allowance",
      nativeToScVal(owner, { type: "address" }),
      nativeToScVal(spender, { type: "address" })
    );
    const result = await this._simulateView(op);
    if (typeof result === "bigint") return result;
    if (typeof result === "number" || typeof result === "string") {
      return BigInt(result);
    }
    return 0n;
  }
}

// ---------------------------------------------------------------------------
// Factory helper
// ---------------------------------------------------------------------------

/**
 * Convenience factory for creating a `Sep41Adapter` from an RPC server and
 * network details.
 */
export function createSep41Adapter(
  tokenAddress: string,
  server: SorobanRpc.Server,
  networkPassphrase: string,
  sourceAccount: string
): Sep41Adapter {
  return new Sep41Adapter(
    tokenAddress,
    server,
    networkPassphrase,
    sourceAccount
  );
}