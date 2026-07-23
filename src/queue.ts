import {
  TransactionBuilder,
  BASE_FEE,
  rpc as SorobanRpc,
  Account,
} from "@stellar/stellar-sdk";
import { signTransaction } from "./wallet.js";
import type { TxResult } from "./client.js";
import { QueueFailedError } from "./errors.js";

/** Transaction queue for serialized submission. */
export class TxQueue {
  private server: SorobanRpc.Server;
  private networkPassphrase: string;
  private sourceAddress: string;
  private queue: Promise<TxResult> = Promise.resolve({ txHash: "" });
  private failed = false;

  constructor(
    server: SorobanRpc.Server,
    networkPassphrase: string,
    sourceAddress: string
  ) {
    this.server = server;
    this.networkPassphrase = networkPassphrase;
    this.sourceAddress = sourceAddress;
  }

  /**
   * Enqueue an operation for sequential execution.
   *
   * @param operation - The operation to execute
   * @returns Promise resolving to transaction result
   */
  async enqueue(
    operation: (
      account: Account
    ) => Promise<{ txHash: string; returnValue: unknown }>
  ): Promise<TxResult> {
    if (this.failed) {
      throw new QueueFailedError();
    }

    this.queue = this.queue.then(async () => {
      try {
        const account = await this.server.getAccount(this.sourceAddress);
        const result = await operation(account);
        return { txHash: result.txHash };
      } catch (error) {
        this.failed = true;
        throw error;
      }
    });

    return this.queue;
  }

  /** Clear the queue and reset state. */
  clear(): void {
    this.queue = Promise.resolve({ txHash: "" });
    this.failed = false;
  }
}