/**
 * OperationBuilder — fluent builder for multi-operation Stellar transaction envelopes.
 *
 * Chains Payment, InvokeHostFunction, and BumpSequence operations, validates the
 * envelope against network limits, and offers .dryRun() / .submit() with
 * integrated simulation via SorobanRpc.Server.simulateTransaction().
 *
 * Issue #476
 */

import {
  Account,
  Asset,
  Operation,
  Transaction,
  TransactionBuilder,
  BASE_FEE,
  rpc as SorobanRpc,
  xdr,
} from "@stellar/stellar-sdk";

import { EnvelopeLimitError, DryRunFailedError } from "../errors.js";

/** Maximum operations allowed per envelope (Stellar protocol limit). */
const MAX_OPERATIONS = 100;

/** Maximum total base fee in stroops. */
const MAX_FEE_STROOPS = 10_000_000;

// ---------------------------------------------------------------------------
// Public option interfaces
// ---------------------------------------------------------------------------

export interface PaymentOptions {
  destination: string;
  asset: Asset;
  amount: string;
  source?: string;
}

export interface InvokeHostFnOptions {
  /** The pre-built InvokeHostFunction xdr.Operation. */
  operation: xdr.Operation;
}

export interface BumpSequenceOptions {
  bumpTo: string;
  source?: string;
}

export interface TimeboundsOptions {
  minTime: number;
  maxTime: number;
}

export interface DryRunResult {
  success: boolean;
  /** Cost in resource fee stroops from simulateTransaction. */
  cost: number;
  /** Raw contract events returned by the simulation. */
  events: xdr.DiagnosticEvent[];
  /** The assembled/prepared XDR string, suitable for signing. */
  simulatedXdr: string;
}

export interface SubmitOptions {
  /** When true, skip dry-run simulation and submit the envelope directly. */
  bypassDryRun?: boolean;
  /** Signed XDR to submit. If omitted, caller must sign separately. */
  signedXdr?: string;
}

export interface OperationBuilderConfig {
  /** Soroban RPC endpoint URL. */
  rpcUrl: string;
  /** Stellar network passphrase. */
  networkPassphrase: string;
  /** Source account G… address. */
  sourceAddress: string;
  /** Optional base fee per operation in stroops. Defaults to BASE_FEE. */
  fee?: string;
}

// ---------------------------------------------------------------------------
// OperationBuilder
// ---------------------------------------------------------------------------

/**
 * Fluent builder for constructing and simulating multi-op transaction envelopes.
 *
 * @example
 * ```typescript
 * const result = await new OperationBuilder(config)
 *   .addPayment({ destination: 'G…', asset: Asset.native(), amount: '10' })
 *   .addInvokeHostFn({ operation: myOp })
 *   .setTimebounds({ minTime: 0, maxTime: Date.now() / 1000 + 300 })
 *   .dryRun();
 * ```
 */
export class OperationBuilder {
  private readonly config: OperationBuilderConfig;
  private readonly server: SorobanRpc.Server;
  private readonly ops: xdr.Operation[] = [];
  private timebounds: TimeboundsOptions | null = null;

  constructor(config: OperationBuilderConfig) {
    this.config = config;
    this.server = new SorobanRpc.Server(config.rpcUrl, {
      allowHttp: config.rpcUrl.startsWith("http://"),
    });
  }

  // --------------------------------------------------------------------------
  // Fluent operation adders
  // --------------------------------------------------------------------------

  /**
   * Appends a Payment operation to the envelope.
   */
  addPayment(opts: PaymentOptions): this {
    const op = Operation.payment({
      destination: opts.destination,
      asset: opts.asset,
      amount: opts.amount,
      source: opts.source,
    });
    this.ops.push(op);
    return this;
  }

  /**
   * Appends a pre-built InvokeHostFunction operation (e.g. from Contract.call()).
   */
  addInvokeHostFn(opts: InvokeHostFnOptions): this {
    this.ops.push(opts.operation);
    return this;
  }

  /**
   * Appends a BumpSequence operation.
   */
  addBumpSequence(opts: BumpSequenceOptions): this {
    const op = Operation.bumpSequence({
      bumpTo: opts.bumpTo,
      source: opts.source,
    });
    this.ops.push(op);
    return this;
  }

  /**
   * Sets envelope-level timebounds (min/max ledger time).
   */
  setTimebounds(opts: TimeboundsOptions): this {
    this.timebounds = opts;
    return this;
  }

  // --------------------------------------------------------------------------
  // Build
  // --------------------------------------------------------------------------

  /**
   * Validates envelope limits and builds an unsigned Transaction.
   *
   * @throws {EnvelopeLimitError} when operation count > 100 or fee > 10_000_000 stroops.
   */
  build(): Transaction {
    this._validate();

    const sourceAccount = this._makeFakeAccount();
    const fee = this.config.fee ?? BASE_FEE;

    // Guard: total fee cannot exceed MAX_FEE_STROOPS
    const totalFee = Number(fee) * this.ops.length;
    if (totalFee > MAX_FEE_STROOPS) {
      throw new EnvelopeLimitError(this.ops.length, MAX_OPERATIONS);
    }

    const tb = new TransactionBuilder(sourceAccount, {
      fee,
      networkPassphrase: this.config.networkPassphrase,
    });

    for (const op of this.ops) {
      tb.addOperation(op);
    }

    if (this.timebounds) {
      tb.setTimebounds(this.timebounds.minTime, this.timebounds.maxTime);
    } else {
      tb.setTimeout(30);
    }

    return tb.build();
  }

  // --------------------------------------------------------------------------
  // Dry-run
  // --------------------------------------------------------------------------

  /**
   * Simulates the entire envelope via simulateTransaction and returns
   * cost, events, and the assembled XDR for inspection or signing.
   */
  async dryRun(): Promise<DryRunResult> {
    const tx = this.build();
    const simResult = await this.server.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(simResult)) {
      return {
        success: false,
        cost: 0,
        events: [],
        simulatedXdr: tx.toXDR(),
      };
    }

    // assembleTransaction enriches the tx with resource limits / fees
    const assembled = SorobanRpc.assembleTransaction(tx, simResult).build();

    const cost =
      "minResourceFee" in simResult
        ? Number((simResult as { minResourceFee: string }).minResourceFee ?? 0)
        : 0;

    const events: xdr.DiagnosticEvent[] =
      "events" in simResult && Array.isArray((simResult as { events?: unknown[] }).events)
        ? ((simResult as { events: xdr.DiagnosticEvent[] }).events)
        : [];

    return {
      success: true,
      cost,
      events,
      simulatedXdr: assembled.toXDR(),
    };
  }

  // --------------------------------------------------------------------------
  // Submit
  // --------------------------------------------------------------------------

  /**
   * Submits the envelope.
   *
   * By default, runs .dryRun() first and throws DryRunFailedError if the
   * simulation reports an error. Pass `bypassDryRun: true` to skip simulation.
   *
   * @param opts.signedXdr  Pre-signed XDR to submit directly (bypasses local build).
   * @param opts.bypassDryRun  Skip dry-run simulation.
   */
  async submit(opts: SubmitOptions = {}): Promise<{ txHash: string }> {
    const { bypassDryRun = false, signedXdr } = opts;

    let txToSubmit: Transaction;

    if (signedXdr) {
      txToSubmit = TransactionBuilder.fromXDR(
        signedXdr,
        this.config.networkPassphrase,
      ) as Transaction;
    } else {
      // Run dry-run unless bypassed
      if (!bypassDryRun) {
        const tx = this.build();
        const simResult = await this.server.simulateTransaction(tx);

        if (SorobanRpc.Api.isSimulationError(simResult)) {
          throw new DryRunFailedError(
            (simResult as { error: string }).error ?? "Unknown simulation error",
          );
        }

        txToSubmit = SorobanRpc.assembleTransaction(tx, simResult).build();
      } else {
        txToSubmit = this.build();
      }
    }

    const sendResult = await this.server.sendTransaction(txToSubmit);

    if (sendResult.status === "ERROR") {
      const errDetail =
        sendResult.errorResult
          ? JSON.stringify(sendResult.errorResult)
          : "Unknown error";
      throw new DryRunFailedError(`Send failed: ${errDetail}`);
    }

    return { txHash: sendResult.hash };
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private _validate(): void {
    if (this.ops.length > MAX_OPERATIONS) {
      throw new EnvelopeLimitError(this.ops.length, MAX_OPERATIONS);
    }
  }

  private _makeFakeAccount(): Account {
    return {
      accountId: () => this.config.sourceAddress,
      sequenceNumber: () => "0",
      incrementSequenceNumber: () => {},
    } as unknown as Account;
  }
}
