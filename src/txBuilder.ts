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
import { SimulationFailedError, TransactionFailedError, TransactionNotConfirmedError } from "./errors.js";
import { checkInvoiceExpiry } from "./preflightChecker.js";
import type { LedgerCloseEstimator } from "./ledgerCloseEstimator.js";

/** Builder for composing multi-operation StellarSplit transactions. */
export class StellarSplitTxBuilder {
  private readonly server: SorobanRpc.Server;
  private readonly contract: Contract;
  private readonly config: StellarSplitClientConfig;
  private readonly sourceAddress: string;
  private readonly operations: xdr.Operation[] = [];
  private _surgeConfig?: FeeSurgeConfig;
  private _ledgerEstimator?: LedgerCloseEstimator;

  constructor(config: StellarSplitClientConfig, sourceAddress: string) {
    this.config = config;
    this.sourceAddress = sourceAddress;
    const rpcUrl = Array.isArray(config.rpcUrl) ? config.rpcUrl[0]! : config.rpcUrl;
    this.server = new SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
    this.contract = new Contract(config.contractId);
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
    const sourceAccount = ({
      accountId: () => this.sourceAddress,
      sequenceNumber: () => sequence,
      incrementSequenceNumber: () => {},
    } as unknown) as Account;

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

    const tb = new TransactionBuilder(account, {
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
    const tx = tb.build();

    const simResult = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new SimulationFailedError(`Simulation failed: ${simResult.error}`, "submit", simResult.error);
    }

    const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();

    const signedXdr = await (this.config.adapter
      ? this.config.adapter.signTransaction(preparedTx.toXDR(), this.config.networkPassphrase)
      : signTransaction(preparedTx.toXDR(), this.config.networkPassphrase));

    const sendResult = await this.server.sendTransaction(
      TransactionBuilder.fromXDR(signedXdr, this.config.networkPassphrase)
    );

    if (sendResult.status === "ERROR") {
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
      throw new TransactionNotConfirmedError(String(getResult.status));
    }

    return { txHash };
  }
}
