import { describe, expect, it } from "vitest";
import { OperationChunker, MAX_OPERATIONS_PER_TRANSACTION } from "../src/operationChunker.js";
import type { OperationOptions } from "@stellar/stellar-base";

function operations(count: number): OperationOptions[] {
  return Array.from({ length: count }, (_, index) => ({
    type: "payment",
    destination: `G${index}`,
    asset: "native",
    amount: "1",
  })) as OperationOptions[];
}

describe("OperationChunker", () => {
  it("chunks 150 recipients into 2 transactions within the operation limit", () => {
    const chunks = OperationChunker.chunk(operations(150));
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.length <= MAX_OPERATIONS_PER_TRANSACTION)).toBe(true);
  });

  it("chunks 250 recipients into 3 transactions within the operation limit", () => {
    const chunks = OperationChunker.chunk(operations(250));
    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.length <= MAX_OPERATIONS_PER_TRANSACTION)).toBe(true);
  });

  it("reports succeeded chunks and stops on partial failure", async () => {
    const chunker = new OperationChunker();
    const result = await chunker.submitAll(OperationChunker.chunk(operations(150)), {
      sourceAddress: "GABC",
      submitChunk: async (_chunk, index) => {
        if (index === 1) throw new Error("failed");
        return { txHash: "hash-0" };
      },
    });

    expect(result.succeeded).toEqual([{ chunkIndex: 0, txHash: "hash-0" }]);
    expect(result.failed?.chunkIndex).toBe(1);
  });
});
