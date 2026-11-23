import {
  Contract,
  rpc as SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  xdr,
  Account,
  Transaction,
  Asset,
  Operation,
} from "@stellar/stellar-sdk";
import type { StellarSplitClientConfig } from "./client.js";
import { signTransaction } from "./wallet.js";
import { ValidationError, SimulationFailedError, TransactionFailedError, TransactionNotConfirmedError } from "./errors.js";
import { checkInvoiceExpiry } from "./preflightChecker.js";
import type { LedgerCloseEstimator } from "./ledgerCloseEstimator.js";
import { detectFeeSurge, type FeeSurgeConfig } from "./feeSurgeDetector.js";
import { NonceManager, type NonceManagerConfig } from "./nonceManager.js";

/** Validation hook: return an error message (or throw) to reject the pending operations. */
export type TxBuilderValidator = (
  operations: readonly xdr.Operation[],
) => string | void;

/** Plugin that observes the builder just before a transaction is built. */
export interface TxBuilderPlugin {
  name: string;
  /** Called before validators run; may add operations via the builder. */
  beforeBuild?(builder: StellarSplitTxBuilder): void;
}

/** Counters tracked by {@link StellarSplitTxBuilder.getStats}. */
export interface TxBuilderStats {
  operations: number;
  builds: number;
  submits: number;
  validationFailures: number;
  plugins: number;
}

/** Builder for composing multi-operation StellarSplit transactions. */
export class StellarSplitTxBuilder {
  private readonly server: SorobanRpc.Server;
  private readonly contract: Contract;
  private readonly config: StellarSplitClientConfig;
  private readonly sourceAddress: string;
  private readonly operations: xdr.Operation[] = [];
  private _surgeConfig?: FeeSurgeConfig;
  private _ledgerEstimator?: LedgerCloseEstimator;
  private _nonceManager?: NonceManager;
  private readonly _validators: TxBuilderValidator[] = [];
  private readonly _plugins: TxBuilderPlugin[] = [];
  private _builds = 0;
  private _submits = 0;
  private _validationFailures = 0;

  constructor(config: StellarSplitClientConfig, sourceAddress: string) {
    this.config = config;
    this.sourceAddress = sourceAddress;
    const rpcUrl = Array.isArray(config.rpcUrl) ? config.rpcUrl[0]! : config.rpcUrl;
    this.server = new SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
    this.contract = new Contract(config.contractId);
  }

  /**
   * Register a validation hook run at the start of {@link build} and
   * {@link submit}. Return a string or throw to reject the build.
   */
  addValidator(validator: TxBuilderValidator): this {
    this._validators.push(validator);
    return this;
  }

  /** Register a plugin; its `beforeBuild` hook runs before validation. */
  use(plugin: TxBuilderPlugin): this {
    this._plugins.push(plugin);
    return this;
  }

  /** Builder usage statistics. */
  getStats(): TxBuilderStats {
    return {
      operations: this.operations.length,
      builds: this._builds,
      submits: this._submits,
      validationFailures: this._validationFailures,
      plugins: this._plugins.length,
    };
  }

  private runPreBuild(): void {
    for (const plugin of this._plugins) plugin.beforeBuild?.(this);
    for (const validator of this._validators) {
      let message: string | void;
      try {
        message = validator(this.operations);
      } catch (err) {
        this._validationFailures++;
        throw err;
      }
      if (typeof message === "string" && message.length > 0) {
        this._validationFailures++;
        throw new ValidationError(`Transaction validation failed: ${message}`);
      }
    }
  }

  /**
   * Enable surge-aware fee adjustment. When the network is congested the
   * builder will apply an increased fee multiplier automatically before
   * signing, keeping transactions from failing due to hard-coded fee values.
   */
  enableSurgeDetection(config?: FeeSurgeConfig): this {
    this._surgeConfig = config ?? {};
    return this;
  }

  /**
   * Attach a {@link LedgerCloseEstimator} to derive precise timebounds from
   * ledger sequence numbers rather than fixed wall-clock offsets.
   *
   * When set, you can pass `targetLedger` to {@link build} / {@link submit}
   * and the builder will compute `timebounds.maxTime` via the estimator.
   *
   * @param estimator - A calibrated {@link LedgerCloseEstimator}.
   */
  setLedgerEstimator(estimator: LedgerCloseEstimator): this {
    this._ledgerEstimator = estimator;
    return this;
  }

  /**
   * Attach a {@link NonceManager} to enable automatic nonce (sequence number)
   * management. When set, {@link build} and {@link submit} acquire the next
   * nonce from the manager instead of hardcoding sequence `0`, and release it
   * back to the manager if building or submission fails.
   *
   * @param manager - A {@link NonceManager} instance (shared across builders
   *   using the same source account to prevent conflicts).
   */
  setNonceManager(manager: NonceManager): this {
    this._nonceManager = manager;
    return this;
  }

  /**
   * Convenience helper that creates and attaches a {@link NonceManager} for
   * this builder's source account.
   *
   * @param config - Optional nonce manager configuration.
   */
  enableNonceManagement(config?: NonceManagerConfig): this {
    this._nonceManager = new NonceManager(this.sourceAddress, config);
    return this;
  }

  /** Returns the attached {@link NonceManager}, if any. */
  get nonceManager(): NonceManager | undefined {
    return this._nonceManager;
  }

  /**
   * Compute a wall-clock `expiresAt` (Unix seconds) from a target ledger
   * sequence, using the attached {@link LedgerCloseEstimator}.
   * Returns `undefined` when no estimator has been set.
   *
   * @param targetLedger - The ledger sequence after which the tx should expire.
   */
  expiresAtFromLedger(targetLedger: number): number | undefined {
    if (!this._ledgerEstimator) return undefined;
    return Math.floor(
      this._ledgerEstimator.estimateCloseTime(targetLedger).getTime() / 1000,
    );
  }

  addPay(invoiceId: string, amount: bigint | number | string): this {
    const op = this.contract.call(
      "pay",
      nativeToScVal(this.sourceAddress, { type: "address" }),
      nativeToScVal(BigInt(invoiceId), { type: "u64" }),
      nativeToScVal(BigInt(amount), { type: "i128" })
    );
    this.operations.push(op);
    return this;
  }

  addRolloverInvoice(
    invoiceId: string,
    newDeadline: number,
    caller: string
  ): this {
    const op = this.contract.call(
      "rollover_invoice",
      nativeToScVal(BigInt(invoiceId), { type: "u64" }),
      nativeToScVal(BigInt(newDeadline), { type: "u64" }),
      nativeToScVal(caller, { type: "address" })
    );
    this.operations.push(op);
    return this;
  }

  addRelease(invoiceId: string): this {
    const op = this.contract.call(
      "release_invoice",
      nativeToScVal(BigInt(invoiceId), { type: "u64" })
    );
    this.operations.push(op);
    return this;
  }

  addRefund(invoiceId: string): this {
    const op = this.contract.call(
      "refund_invoice",
      nativeToScVal(BigInt(invoiceId), { type: "u64" })
    );
    this.operations.push(op);
    return this;
  }

  /**
   * Add a ManageData operation for setting or clearing an account data entry.
   * Pass `value: null` to clear the entry.
   */
  addManageData(key: string, value: string | null): this {
    const op = Operation.manageData({ name: key, value });
    this.operations.push(op);
    return this;
  }

  /**
   * Add a PathPaymentStrictSend operation for cross-asset DEX-routed payments.
   */
  addPathPaymentStrictSend(
    sendAsset: Asset,
    sendAmount: string,
    destination: string,
    destAsset: Asset,
    destMin: string,
    path: Asset[],
  ): this {
    const op = Operation.pathPaymentStrictSend({
      sendAsset,
      sendAmount,
      destination,
      destAsset,
      destMin,
      path,
    });
    this.operations.push(op);
    return this;
  }

  /**
   * Add a PathPaymentStrictReceive operation for cross-asset DEX-routed payments.
   */
  addPathPaymentStrictReceive(
    sendAsset: Asset,
    sendMax: string,
    destination: string,
    destAsset: Asset,
    destAmount: string,
    path: Asset[],
  ): this {
    const op = Operation.pathPaymentStrictReceive({
      sendAsset,
      sendMax,
      destination,
      destAsset,
      destAmount,
      path,
    });
    this.operations.push(op);
    return this;
  }

  /**
   * Build an unsigned Transaction using a fallback source account (sequence 0).
   * This is synchronous and suitable for offline signing or inspection.
   *
   * @param options - Optional invoice expiry info.
   * @param options.expiresAt - Unix timestamp (seconds) for invoice expiry.
   * @param options.invoiceId  - Invoice ID for accurate error reporting.
   */
  build(options?: { expiresAt?: number; invoiceId?: string }): Transaction {
    const expiresAt = options?.expiresAt;
    const invoiceId = options?.invoiceId ?? "unknown";

    this.runPreBuild();
    this._builds++;

    // Acquire the next nonce from the manager when available; otherwise fall
    // back to sequence 0 for offline/inspection builds.
    const nonce = this._nonceManager
      ? this._nonceManager.acquire()
      : undefined;
    const sequence = nonce !== undefined ? String(nonce) : "0";

    const sourceAccount = ({
      accountId: () => this.sourceAddress,
      sequenceNumber: () => sequence,
      incrementSequenceNumber: () => {},
    } as unknown) as Account;

    try {
      const tb = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.config.networkPassphrase,
      });

      for (const op of this.operations) {
        tb.addOperation(op);
      }

      if (expiresAt !== undefined) {
        // Enforce invoice expiry at the ledger level via timebounds.
        const expiry = checkInvoiceExpiry(expiresAt, invoiceId);
        const timeoutSeconds = Math.max(1, expiry.secondsRemaining);
        // Cap at 12 hours (43200s) to avoid unreasonable timebounds
        tb.setTimeout(Math.min(timeoutSeconds, 43200));
      } else {
        tb.setTimeout(30);
      }
      return tb.build();
    } catch (err) {
      // Roll back the reserved nonce so it can be reused.
      if (this._nonceManager && nonce !== undefined) {
        this._nonceManager.release(nonce);
      }
      throw err;
    }
  }

  /**
   * Sign and submit the composed transaction. Returns transaction hash when confirmed.
   *
   * @param options - Optional invoice expiry info.
   * @param options.expiresAt - Unix timestamp (seconds) for invoice expiry.
   * @param options.invoiceId  - Invoice ID for accurate error reporting.
   */
  async submit(options?: { expiresAt?: number; invoiceId?: string }): Promise<{ txHash: string }> {
    const expiresAt = options?.expiresAt;
    const invoiceId = options?.invoiceId ?? "unknown";

    this.runPreBuild();
    this._submits++;

    if (expiresAt !== undefined) {
      // Fail fast before fetching account / building tx
      checkInvoiceExpiry(expiresAt, invoiceId);
    }

    const account = await this.server.getAccount(this.sourceAddress);

    // Resolve the fee: use surge-adjusted fee when enabled, otherwise BASE_FEE.
    let fee = BASE_FEE;
    if (this._surgeConfig && this.config.horizonUrl) {
      try {
        const rec = await detectFeeSurge(this.config.horizonUrl, this._surgeConfig);
        fee = rec.surgeActive ? String(rec.fee) : BASE_FEE;
      } catch {
        // Surge detection failed — fall back to BASE_FEE silently.
      }
    }

    // Acquire the next nonce from the manager when available. The manager
    // tracks the account's on-chain sequence so concurrent submissions do not
    // collide.
    const nonce = this._nonceManager
      ? this._nonceManager.acquire()
      : undefined;
    const sequence = nonce !== undefined ? String(nonce) : account.sequenceNumber();

    const sourceAccount = ({
      accountId: () => this.sourceAddress,
      sequenceNumber: () => sequence,
      incrementSequenceNumber: () => {},
    } as unknown) as Account;

    let tx: Transaction;
    try {
      const tb = new TransactionBuilder(sourceAccount, {
        fee,
        networkPassphrase: this.config.networkPassphrase,
      });

      for (const op of this.operations) tb.addOperation(op);

      if (expiresAt !== undefined) {
        const nowSeconds = Math.floor(Date.now() / 1000);
        const timeoutSeconds = Math.max(1, expiresAt - nowSeconds);
        tb.setTimeout(Math.min(timeoutSeconds, 43200));
      } else {
        tb.setTimeout(30);
      }
      tx = tb.build();
    } catch (err) {
      if (this._nonceManager && nonce !== undefined) {
        this._nonceManager.release(nonce);
      }
      throw err;
    }

    let preparedTx: Transaction;
    try {
      const simResult = await this.server.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(simResult)) {
        throw new SimulationFailedError(`Simulation failed: ${simResult.error}`, "submit", simResult.error);
      }
      preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
    } catch (err) {
      if (this._nonceManager && nonce !== undefined) {
        this._nonceManager.release(nonce);
      }
      throw err;
    }

    const signedXdr = await (this.config.adapter
      ? this.config.adapter.signTransaction(preparedTx.toXDR(), this.config.networkPassphrase)
      : signTransaction(preparedTx.toXDR(), this.config.networkPassphrase));

    const sendResult = await this.server.sendTransaction(
      TransactionBuilder.fromXDR(signedXdr, this.config.networkPassphrase)
    );

    if (sendResult.status === "ERROR") {
      // Submission rejected — release the nonce so it can be retried.
      if (this._nonceManager && nonce !== undefined) {
        this._nonceManager.release(nonce);
      }
      throw new TransactionFailedError(
        `Transaction failed: ${JSON.stringify(sendResult.errorResult)}`
      );
    }

    const txHash = sendResult.hash;
    let getResult = await this.server.getTransaction(txHash);
    let attempts = 0;
    while (
      getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND &&
      attempts < 20
    ) {
      await new Promise((r) => setTimeout(r, 1500));
      getResult = await this.server.getTransaction(txHash);
      attempts++;
    }

    if (getResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      if (this._nonceManager && nonce !== undefined) {
        this._nonceManager.release(nonce);
      }
      throw new TransactionNotConfirmedError(String(getResult.status));
    }

    // Confirm the nonce as consumed so the manager advances its sequence.
    if (this._nonceManager && nonce !== undefined) {
      this._nonceManager.confirm(nonce);
    }

    return { txHash };
  }
}
