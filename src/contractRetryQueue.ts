/**
 * Persistent retry queue for Soroban contract invocations.
 *
 * Wraps a caller-supplied executor (which builds the initial unsigned
 * transaction and signs/submits a resource-assembled one) with re-simulation,
 * exponential backoff, and durable tracking so transient ledger congestion or
 * fee/resource mis-estimation doesn't surface as an immediate failure to the
 * caller.
 *
 * Note: `RetryEngine` (retryEngine.ts) intentionally never retries
 * contract-classified errors, so this queue implements its own backoff loop
 * rather than reusing that engine.
 */

import { rpc as SorobanRpc, type Transaction } from "@stellar/stellar-sdk";
import type { ContractInvocation, ContractResult } from "./types.js";
import { ContractRetryExhaustedError } from "./errors.js";
import { PersistentTxQueue } from "./persistentQueue.js";
import { TypedEventEmitter, type Unsubscribe } from "./events/TypedEventEmitter.js";

/** Builds and submits the transaction for a contract invocation. */
export interface ContractInvocationExecutor {
  /** Build the unsigned transaction for this invocation (fee/sequence handled by the caller). */
  buildTransaction(invocation: ContractInvocation): Promise<Transaction>;
  /** Sign and submit a simulated-and-assembled transaction, returning the result once confirmed. */
  submit(tx: Transaction): Promise<ContractResult>;
}

export interface ContractRetryQueueConfig {
  /** Initial backoff delay in milliseconds. Default: 500. */
  baseDelayMs?: number;
  /** Maximum backoff delay in milliseconds. Default: 30 000. */
  maxDelayMs?: number;
  /** Maximum number of attempts before giving up. Default: 5. */
  maxAttempts?: number;
}

interface ContractRetryEvents {
  contractRetryAttempted: { invocation: ContractInvocation; attempt: number; delay: number; error: unknown };
  contractRetryExhausted: { invocation: ContractInvocation; attempts: number; error: unknown };
}

const DEFAULT_CONFIG: Required<ContractRetryQueueConfig> = {
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 5,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ContractRetryQueue {
  private readonly _config: Required<ContractRetryQueueConfig>;
  private readonly _emitter = new TypedEventEmitter<ContractRetryEvents>();
  private readonly _persistentQueue = new PersistentTxQueue();
  private _seq = 0;

  constructor(
    private readonly server: SorobanRpc.Server,
    private readonly executor: ContractInvocationExecutor,
    config: ContractRetryQueueConfig = {}
  ) {
    this._config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Subscribe to `contractRetryAttempted` / `contractRetryExhausted` events. */
  on<K extends keyof ContractRetryEvents>(
    event: K,
    handler: (payload: ContractRetryEvents[K]) => void
  ): Unsubscribe {
    return this._emitter.on(event, handler);
  }

  /**
   * Enqueue a contract invocation. Resolves once the invocation succeeds,
   * re-simulating and resubmitting with exponential backoff on failure.
   *
   * @throws {ContractRetryExhaustedError} After `maxAttempts` failed attempts.
   */
  async enqueue(invocation: ContractInvocation): Promise<ContractResult> {
    const id = `contract-retry-${++this._seq}-${invocation.contractId}`;
    await this._persistentQueue.enqueue({ id, payload: invocation, enqueuedAt: Date.now() });

    try {
      return await this._runWithRetry(invocation);
    } finally {
      await this._persistentQueue.remove(id);
    }
  }

  private async _runWithRetry(invocation: ContractInvocation): Promise<ContractResult> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this._config.maxAttempts; attempt++) {
      try {
        return await this._attempt(invocation);
      } catch (error) {
        lastError = error;
        if (attempt >= this._config.maxAttempts) break;

        const delay = Math.min(
          this._config.baseDelayMs * 2 ** (attempt - 1),
          this._config.maxDelayMs
        );
        this._emitter.emit("contractRetryAttempted", { invocation, attempt, delay, error });
        await sleep(delay);
      }
    }

    this._emitter.emit("contractRetryExhausted", {
      invocation,
      attempts: this._config.maxAttempts,
      error: lastError,
    });
    throw new ContractRetryExhaustedError(this._config.maxAttempts, lastError);
  }

  private async _attempt(invocation: ContractInvocation): Promise<ContractResult> {
    const tx = await this.executor.buildTransaction(invocation);
    const simResult = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error(`Simulation failed: ${simResult.error}`);
    }

    const prepared = SorobanRpc.assembleTransaction(tx, simResult).build();
    return this.executor.submit(prepared);
  }
}
