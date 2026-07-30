import { describe, it, expect, vi, beforeEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";

const { assembleTransactionMock, isSimulationErrorMock } = vi.hoisted(() => ({
  assembleTransactionMock: vi.fn(),
  isSimulationErrorMock: vi.fn(),
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      assembleTransaction: assembleTransactionMock,
      Api: {
        ...actual.rpc.Api,
        isSimulationError: isSimulationErrorMock,
      },
    },
  };
});

const { ContractRetryQueue } = await import("../src/contractRetryQueue.js");
const { ContractRetryExhaustedError } = await import("../src/errors.js");
import type { ContractInvocation } from "../src/types.js";
import type { ContractInvocationExecutor } from "../src/contractRetryQueue.js";

const invocation: ContractInvocation = {
  contractId: "CCONTRACT",
  method: "release",
  args: [],
  source: "GSOURCE",
};

function makeExecutor(submit: ContractInvocationExecutor["submit"]): ContractInvocationExecutor {
  return {
    buildTransaction: vi.fn().mockResolvedValue({ tx: true }),
    submit,
  };
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).indexedDB = new IDBFactory();
  assembleTransactionMock.mockReset();
  isSimulationErrorMock.mockReset();
  isSimulationErrorMock.mockReturnValue(false);
  assembleTransactionMock.mockImplementation(() => ({ build: () => ({ prepared: true }) }));
});

describe("ContractRetryQueue", () => {
  it("resolves on the first successful attempt without emitting retry events", async () => {
    const server = { simulateTransaction: vi.fn().mockResolvedValue({ result: {} }) } as any;
    const submit = vi.fn().mockResolvedValue({ txHash: "tx1" });
    const executor = makeExecutor(submit);
    const queue = new ContractRetryQueue(server, executor, { baseDelayMs: 5, maxDelayMs: 20, maxAttempts: 3 });

    const attempted = vi.fn();
    queue.on("contractRetryAttempted", attempted);

    const result = await queue.enqueue(invocation);

    expect(result).toEqual({ txHash: "tx1" });
    expect(server.simulateTransaction).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(attempted).not.toHaveBeenCalled();
  });

  it("re-simulates and resubmits on failure, succeeding within maxAttempts", async () => {
    const server = { simulateTransaction: vi.fn().mockResolvedValue({ result: {} }) } as any;
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new Error("resource limits exceeded"))
      .mockResolvedValueOnce({ txHash: "tx2" });
    const executor = makeExecutor(submit);
    const queue = new ContractRetryQueue(server, executor, { baseDelayMs: 5, maxDelayMs: 20, maxAttempts: 3 });

    const attempted: unknown[] = [];
    queue.on("contractRetryAttempted", (payload) => attempted.push(payload));

    const result = await queue.enqueue(invocation);

    expect(result).toEqual({ txHash: "tx2" });
    expect(server.simulateTransaction).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(attempted).toHaveLength(1);
    expect(attempted[0]).toMatchObject({ attempt: 1, delay: 5 });
  });

  it("throws ContractRetryExhaustedError and emits contractRetryExhausted after maxAttempts", async () => {
    const server = { simulateTransaction: vi.fn().mockResolvedValue({ result: {} }) } as any;
    const submit = vi.fn().mockRejectedValue(new Error("always fails"));
    const executor = makeExecutor(submit);
    const queue = new ContractRetryQueue(server, executor, { baseDelayMs: 5, maxDelayMs: 20, maxAttempts: 3 });

    const exhausted = vi.fn();
    queue.on("contractRetryExhausted", exhausted);

    await expect(queue.enqueue(invocation)).rejects.toThrow(ContractRetryExhaustedError);
    expect(submit).toHaveBeenCalledTimes(3);
    expect(exhausted).toHaveBeenCalledTimes(1);
    expect(exhausted.mock.calls[0]![0]).toMatchObject({ attempts: 3 });
  });

  it("throws when simulation fails", async () => {
    const server = { simulateTransaction: vi.fn().mockResolvedValue({ error: "sim error" }) } as any;
    isSimulationErrorMock.mockReturnValue(true);
    const submit = vi.fn();
    const executor = makeExecutor(submit);
    const queue = new ContractRetryQueue(server, executor, { baseDelayMs: 5, maxDelayMs: 20, maxAttempts: 1 });

    await expect(queue.enqueue(invocation)).rejects.toThrow(ContractRetryExhaustedError);
    expect(submit).not.toHaveBeenCalled();
  });
});
