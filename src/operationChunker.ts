import { IdempotencyManager } from "./idempotency.js";
import type { BatchPaymentResult, ChunkSubmitter } from "./types.js";
import type { OperationOptions } from "@stellar/stellar-base";

export const MAX_OPERATIONS_PER_TRANSACTION = 100;

export class OperationChunker {
  private readonly idempotency: IdempotencyManager;

  constructor(idempotency = new IdempotencyManager()) {
    this.idempotency = idempotency;
  }

  static chunk<T extends OperationOptions>(operations: T[], chunkSize = MAX_OPERATIONS_PER_TRANSACTION): T[][] {
    if (chunkSize <= 0) {
      throw new Error("chunkSize must be greater than zero");
    }

    const chunks: T[][] = [];
    for (let index = 0; index < operations.length; index += chunkSize) {
      chunks.push(operations.slice(index, index + chunkSize));
    }
    return chunks;
  }

  chunk<T extends OperationOptions>(operations: T[], chunkSize = MAX_OPERATIONS_PER_TRANSACTION): T[][] {
    return OperationChunker.chunk(operations, chunkSize);
  }

  async submitAll<T extends OperationOptions>(
    chunks: T[][],
    config: { sourceAddress: string; submitChunk: ChunkSubmitter<T> },
  ): Promise<BatchPaymentResult> {
    const result: BatchPaymentResult = { succeeded: [], failed: null };

    for (let index = 0; index < chunks.length; index++) {
      const operations = chunks[index]!;
      const key = this.idempotency.generateKey(
        config.sourceAddress,
        JSON.stringify({ index, operations }),
      );
      const existing = this.idempotency.getResult(key);

      if (existing) {
        result.succeeded.push({ chunkIndex: index, txHash: existing.txHash });
        continue;
      }

      try {
        const submitted = await config.submitChunk(operations, index);
        this.idempotency.tryClaim(key, { txHash: submitted.txHash });
        result.succeeded.push({ chunkIndex: index, txHash: submitted.txHash });
      } catch (error) {
        result.failed = {
          chunkIndex: index,
          error: error instanceof Error ? error : new Error(String(error)),
        };
        break;
      }
    }

    return result;
  }
}
