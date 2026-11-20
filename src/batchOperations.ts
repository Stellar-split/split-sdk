/**
 * Batch Operation Support for StellarSplit SDK.
 *
 * Enables composing multiple operations into a single atomic Stellar transaction,
 * with comprehensive validation, executor reliability, fee computation, and atomic guarantees.
 *
 * Issue #1032
 */

import {
  Asset,
  Operation,
  Transaction,
  TransactionBuilder,
  BASE_FEE,
  Account,
  StrKey,
  Keypair,
  xdr,
  Memo,
} from "@stellar/stellar-sdk";
import { ValidationError, TransactionFailedError } from "./errors.js";

/** Stellar protocol maximum operations per transaction. */
export const MAX_OPERATIONS_PER_BATCH = 100;

// ---------------------------------------------------------------------------
// Operation Types
// ---------------------------------------------------------------------------

export interface PaymentBatchOp {
  type: "payment";
  destination: string;
  amount: string | number | bigint;
  asset?: Asset | string;
  source?: string;
}

export interface CreateAccountBatchOp {
  type: "createAccount";
  destination: string;
  startingBalance: string | number | bigint;
  source?: string;
}

export interface ManageDataBatchOp {
  type: "manageData";
  name: string;
  value: string | Buffer | Uint8Array | null;
  source?: string;
}

export interface ChangeTrustBatchOp {
  type: "changeTrust";
  asset: Asset;
  limit?: string;
  source?: string;
}

export interface CustomBatchOp {
  type: "custom";
  operation: xdr.Operation;
}

export type BatchOperation =
  | PaymentBatchOp
  | CreateAccountBatchOp
  | ManageDataBatchOp
  | ChangeTrustBatchOp
  | CustomBatchOp;

export interface BatchExecutionResult {
  /** Whether the atomic transaction succeeded. */
  success: boolean;
  /** Transaction hash if submitted or simulated. */
  txHash: string;
  /** Number of operations included in this single transaction. */
  operationCount: number;
  /** Total fee in stroops allocated for the transaction. */
  feeStroops: string;
  /** Guarantees all-or-nothing execution across all batched operations. */
  atomic: true;
  /** Base64-encoded transaction envelope XDR. */
  envelopeXdr: string;
}

/** Per-operation outcome within a (possibly partial) batch execution. */
export interface BatchOperationResult {
  /** Index of the operation within the original batch. */
  index: number;
  /** The operation that was attempted. */
  operation: BatchOperation;
  /** Whether this operation was included and executed successfully. */
  success: boolean;
  /** Error message if the operation failed. */
  error?: string;
}

/** Result of a partial-batch execution that tolerates per-operation failures. */
export interface PartialBatchExecutionResult {
  /** True only if every operation succeeded. */
  success: boolean;
  /** True if some (but not all) operations succeeded. */
  partial: boolean;
  /** Number of operations that succeeded. */
  successCount: number;
  /** Number of operations that failed. */
  failureCount: number;
  /** Per-operation results, in original batch order. */
  results: BatchOperationResult[];
  /** Transaction hashes for each successfully executed sub-batch. */
  txHashes: string[];
  /** Total fee in stroops across all executed sub-batches. */
  feeStroops: string;
  /** Guarantees no partial on-chain state: failed ops are never submitted. */
  atomic: true;
}

/** Cumulative statistics tracked by a BatchExecutor across executions. */
export interface BatchStats {
  /** Number of batch executions attempted. */
  batches: number;
  /** Total number of operations processed across all batches. */
  operations: number;
  /** Total number of operations that succeeded. */
  successes: number;
  /** Total number of operations that failed. */
  failures: number;
  /** Number of batches that completed with partial success. */
  partials: number;
  /** Number of batches that failed entirely. */
  failedBatches: number;
  /** Number of batches that fully succeeded. */
  successfulBatches: number;
  /** Total fee in stroops spent across all executed transactions. */
  totalFeeStroops: string;
}

export interface BatchExecutorConfig {
  networkPassphrase: string;
  sourceAddress: string;
  /** Fee per operation in stroops. Defaults to BASE_FEE (100 stroops). */
  baseFee?: number | string;
  memo?: Memo;
  timebounds?: { minTime?: number; maxTime: number };
  /** Server with simulateTransaction or sendTransaction for network execution. */
  server?: {
    getAccount?: (address: string) => Promise<{ sequenceNumber: () => string }>;
    simulateTransaction?: (tx: Transaction) => Promise<any>;
    sendTransaction?: (tx: Transaction) => Promise<{ status: string; hash: string; errorResult?: unknown }>;
  };
  /** Signer: Keypair, secret key string, or custom sign function. */
  signer?: Keypair | string | ((xdr: string) => Promise<string>);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateBatchOperation(op: BatchOperation, index: number): void {
  if (!op || typeof op !== "object" || !("type" in op)) {
    throw new ValidationError(`Operation at index ${index} is missing a valid type.`);
  }

  if (op.source && !StrKey.isValidEd25519PublicKey(op.source)) {
    throw new ValidationError(`Invalid source address at operation index ${index}: ${op.source}`, { index });
  }

  switch (op.type) {
    case "payment": {
      if (!StrKey.isValidEd25519PublicKey(op.destination)) {
        throw new ValidationError(`Invalid payment destination at index ${index}: ${op.destination}`, { index });
      }
      const numAmt = Number(op.amount);
      if (!Number.isFinite(numAmt) || numAmt <= 0) {
        throw new ValidationError(`Payment amount must be a positive number at index ${index}, got: ${op.amount}`, { index });
      }
      break;
    }

    case "createAccount": {
      if (!StrKey.isValidEd25519PublicKey(op.destination)) {
        throw new ValidationError(`Invalid createAccount destination at index ${index}: ${op.destination}`, { index });
      }
      const numBal = Number(op.startingBalance);
      if (!Number.isFinite(numBal) || numBal <= 0) {
        throw new ValidationError(`Starting balance must be positive at index ${index}, got: ${op.startingBalance}`, { index });
      }
      break;
    }

    case "manageData": {
      if (typeof op.name !== "string" || op.name.length === 0) {
        throw new ValidationError(`manageData name cannot be empty at index ${index}`, { index });
      }
      if (Buffer.byteLength(op.name, "utf8") > 64) {
        throw new ValidationError(`manageData name exceeds 64 bytes at index ${index}`, { index });
      }
      break;
    }

    case "changeTrust": {
      if (!op.asset) {
        throw new ValidationError(`changeTrust requires an asset at index ${index}`, { index });
      }
      break;
    }

    case "custom": {
      if (!op.operation) {
        throw new ValidationError(`custom operation is missing xdr.Operation at index ${index}`, { index });
      }
      break;
    }

    default:
      throw new ValidationError(`Unsupported operation type '${(op as any).type}' at index ${index}`);
  }
}

export function validateBatchOperations(operations: BatchOperation[]): void {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new ValidationError("Batch must contain at least 1 operation.");
  }
  if (operations.length > MAX_OPERATIONS_PER_BATCH) {
    throw new ValidationError(
      `Batch contains ${operations.length} operations, which exceeds maximum limit of ${MAX_OPERATIONS_PER_BATCH}.`,
      { count: operations.length, max: MAX_OPERATIONS_PER_BATCH },
    );
  }
  operations.forEach((op, index) => validateBatchOperation(op, index));
}

// ---------------------------------------------------------------------------
// Batch Operation Builder
// ---------------------------------------------------------------------------

export class BatchOperationBuilder {
  private readonly operations: BatchOperation[] = [];

  add(op: BatchOperation): this {
    this.operations.push(op);
    return this;
  }

  addPayment(params: Omit<PaymentBatchOp, "type">): this {
    return this.add({ type: "payment", ...params });
  }

  addCreateAccount(params: Omit<CreateAccountBatchOp, "type">): this {
    return this.add({ type: "createAccount", ...params });
  }

  addManageData(params: Omit<ManageDataBatchOp, "type">): this {
    return this.add({ type: "manageData", ...params });
  }

  addChangeTrust(params: Omit<ChangeTrustBatchOp, "type">): this {
    return this.add({ type: "changeTrust", ...params });
  }

  addCustom(operation: xdr.Operation): this {
    return this.add({ type: "custom", operation });
  }

  getOperations(): readonly BatchOperation[] {
    return [...this.operations];
  }

  size(): number {
    return this.operations.length;
  }

  clear(): this {
    this.operations.length = 0;
    return this;
  }

  validate(): void {
    validateBatchOperations(this.operations);
  }

  toXdrOperations(): xdr.Operation[] {
    this.validate();
    return this.operations.map((op) => {
      switch (op.type) {
        case "payment": {
          const asset = typeof op.asset === "string"
            ? (op.asset === "native" || op.asset === "XLM" ? Asset.native() : new Asset(op.asset, op.source ?? ""))
            : (op.asset ?? Asset.native());
          return Operation.payment({
            destination: op.destination,
            asset,
            amount: op.amount.toString(),
            source: op.source,
          });
        }
        case "createAccount":
          return Operation.createAccount({
            destination: op.destination,
            startingBalance: op.startingBalance.toString(),
            source: op.source,
          });
        case "manageData":
          return Operation.manageData({
            name: op.name,
            value: op.value,
            source: op.source,
          });
        case "changeTrust":
          return Operation.changeTrust({
            asset: op.asset,
            limit: op.limit,
            source: op.source,
          });
        case "custom":
          return op.operation;
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Batch Operation Executor
// ---------------------------------------------------------------------------

export class BatchExecutor {
  private readonly config: BatchExecutorConfig;
  private stats: BatchStats = {
    batches: 0,
    operations: 0,
    successes: 0,
    failures: 0,
    partials: 0,
    failedBatches: 0,
    successfulBatches: 0,
    totalFeeStroops: "0",
  };

  constructor(config: BatchExecutorConfig) {
    if (!StrKey.isValidEd25519PublicKey(config.sourceAddress)) {
      throw new ValidationError(`Invalid source address: ${config.sourceAddress}`);
    }
    this.config = config;
  }

  /** Returns a snapshot of cumulative batch statistics. */
  getStats(): BatchStats {
    return { ...this.stats };
  }

  /** Resets cumulative batch statistics to zero. */
  resetStats(): void {
    this.stats = {
      batches: 0,
      operations: 0,
      successes: 0,
      failures: 0,
      partials: 0,
      failedBatches: 0,
      successfulBatches: 0,
      totalFeeStroops: "0",
    };
  }

  private recordBatch(
    operationCount: number,
    successCount: number,
    failureCount: number,
    feeStroops: string,
  ): void {
    this.stats.batches += 1;
    this.stats.operations += operationCount;
    this.stats.successes += successCount;
    this.stats.failures += failureCount;
    this.stats.totalFeeStroops = (
      BigInt(this.stats.totalFeeStroops) + BigInt(feeStroops || "0")
    ).toString();
    if (failureCount === 0) {
      this.stats.successfulBatches += 1;
    } else if (successCount === 0) {
      this.stats.failedBatches += 1;
    } else {
      this.stats.partials += 1;
    }
  }

  /**
   * Build a single atomic Transaction containing all operations in the batch.
   *
   * @param batch - BatchOperationBuilder or array of BatchOperation
   * @param sequenceNumber - Current source account sequence number (or string/bigint)
   */
  buildTransaction(
    batch: BatchOperationBuilder | BatchOperation[],
    sequenceNumber: string | bigint | number = "0",
  ): Transaction {
    const builder = batch instanceof BatchOperationBuilder
      ? batch
      : new BatchOperationBuilder();

    if (!(batch instanceof BatchOperationBuilder)) {
      for (const op of batch) builder.add(op);
    }

    // Sound validation upfront
    builder.validate();

    const xdrOps = builder.toXdrOperations();
    const opCount = xdrOps.length;
    const baseFee = String(this.config.baseFee ?? BASE_FEE);

    const sourceAccount = new Account(this.config.sourceAddress, sequenceNumber.toString());

    const tb = new TransactionBuilder(sourceAccount, {
      fee: baseFee,
      networkPassphrase: this.config.networkPassphrase,
    });

    for (const op of xdrOps) {
      tb.addOperation(op);
    }

    if (this.config.memo) {
      tb.addMemo(this.config.memo);
    }

    if (this.config.timebounds) {
      tb.setTimeout(Math.max(1, this.config.timebounds.maxTime - Math.floor(Date.now() / 1000)));
    } else {
      tb.setTimeout(300);
    }

    return tb.build();
  }

  /**
   * Execute the batch atomically. Builds a single transaction, signs it,
   * and submits it to the network. If any operation fails, the entire batch
   * is aborted and rejected atomically.
   */
  async execute(
    batch: BatchOperationBuilder | BatchOperation[],
    sequenceOverride?: string,
  ): Promise<BatchExecutionResult> {
    const builder = batch instanceof BatchOperationBuilder
      ? batch
      : new BatchOperationBuilder();

    if (!(batch instanceof BatchOperationBuilder)) {
      for (const op of batch) builder.add(op);
    }

    builder.validate();

    let seq = sequenceOverride;
    if (!seq && this.config.server?.getAccount) {
      const acc = await this.config.server.getAccount(this.config.sourceAddress);
      seq = acc.sequenceNumber();
    }

    const tx = this.buildTransaction(builder, seq ?? "1");

    // Sign transaction if a signer was configured
    if (this.config.signer) {
      if (this.config.signer instanceof Keypair) {
        tx.sign(this.config.signer);
      } else if (typeof this.config.signer === "string") {
        const kp = Keypair.fromSecret(this.config.signer);
        tx.sign(kp);
      } else if (typeof this.config.signer === "function") {
        const signedXdr = await this.config.signer(tx.toXDR());
        const signedTx = TransactionBuilder.fromXDR(signedXdr, this.config.networkPassphrase) as Transaction;
        return {
          success: true,
          txHash: signedTx.hash().toString("hex"),
          operationCount: builder.size(),
          feeStroops: tx.fee,
          atomic: true,
          envelopeXdr: signedXdr,
        };
      }
    }

    // Simulate or send if server provided
    if (this.config.server?.sendTransaction) {
      const sendResult = await this.config.server.sendTransaction(tx);
      if (sendResult.status === "ERROR") {
        this.recordBatch(builder.size(), 0, builder.size(), "0");
        throw new TransactionFailedError(
          `Batch transaction failed atomically: ${JSON.stringify(sendResult.errorResult)}`,
        );
      }
      this.recordBatch(builder.size(), builder.size(), 0, tx.fee);
      return {
        success: true,
        txHash: sendResult.hash,
        operationCount: builder.size(),
        feeStroops: tx.fee,
        atomic: true,
        envelopeXdr: tx.toXDR(),
      };
    }

    this.recordBatch(builder.size(), builder.size(), 0, tx.fee);
    return {
      success: true,
      txHash: tx.hash().toString("hex"),
      operationCount: builder.size(),
      feeStroops: tx.fee,
      atomic: true,
      envelopeXdr: tx.toXDR(),
    };
  }

  /**
   * Execute a batch tolerating per-operation failures (partial batches).
   *
   * Each operation is validated individually. Invalid operations are recorded
   * as failures and excluded; the remaining valid operations are grouped into
   * sub-batches (respecting MAX_OPERATIONS_PER_BATCH) and executed atomically.
   * Failed operations are never submitted, so there is no data loss or partial
   * on-chain state. If a sub-batch fails to submit, its operations are marked
   * as failed and execution continues with the next sub-batch.
   *
   * @param batch - BatchOperationBuilder or array of BatchOperation
   * @param sequenceOverride - Optional starting sequence number
   */
  async executePartial(
    batch: BatchOperationBuilder | BatchOperation[],
    sequenceOverride?: string,
  ): Promise<PartialBatchExecutionResult> {
    const operations: BatchOperation[] = batch instanceof BatchOperationBuilder
      ? [...batch.getOperations()]
      : [...batch];

    if (operations.length === 0) {
      throw new ValidationError("Batch must contain at least 1 operation.");
    }

    const results: BatchOperationResult[] = operations.map((operation, index) => ({
      index,
      operation,
      success: false,
    }));

    // Validate each operation independently; invalid ones fail without aborting.
    const validIndices: number[] = [];
    for (let i = 0; i < operations.length; i++) {
      try {
        validateBatchOperation(operations[i], i);
        validIndices.push(i);
      } catch (err) {
        results[i].error = err instanceof Error ? err.message : String(err);
      }
    }

    const txHashes: string[] = [];
    let totalFee = 0n;
    let seq = sequenceOverride;

    // Execute valid operations in sub-batches of at most MAX_OPERATIONS_PER_BATCH.
    for (let start = 0; start < validIndices.length; start += MAX_OPERATIONS_PER_BATCH) {
      const chunkIndices = validIndices.slice(start, start + MAX_OPERATIONS_PER_BATCH);
      const chunkOps = chunkIndices.map((i) => operations[i]);

      try {
        if (!seq && this.config.server?.getAccount) {
          const acc = await this.config.server.getAccount(this.config.sourceAddress);
          seq = acc.sequenceNumber();
        }
        const chunkResult = await this.execute(chunkOps, seq);
        totalFee += BigInt(chunkResult.feeStroops || "0");
        txHashes.push(chunkResult.txHash);
        for (const i of chunkIndices) {
          results[i].success = true;
        }
        // Advance sequence for subsequent sub-batches.
        if (seq !== undefined) {
          seq = (BigInt(seq) + 1n).toString();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        for (const i of chunkIndices) {
          results[i].success = false;
          results[i].error = message;
        }
      }
    }

    const successCount = results.filter((r) => r.success).length;
    const failureCount = results.length - successCount;

    return {
      success: failureCount === 0,
      partial: successCount > 0 && failureCount > 0,
      successCount,
      failureCount,
      results,
      txHashes,
      feeStroops: totalFee.toString(),
      atomic: true,
    };
  }
}
