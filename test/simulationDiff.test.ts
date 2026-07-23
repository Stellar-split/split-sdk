import { describe, it, expect } from "vitest";
import { diffSimulations } from "../src/simulationDiff.js";
import type { SimulationDiffSuccess } from "../src/simulationDiff.js";
import { rpc as SorobanRpc } from "@stellar/stellar-sdk";

function makeSuccessResponse(
  minResourceFee: string,
  eventCount: number,
): SorobanRpc.Api.SimulateTransactionSuccessResponse {
  return {
    _parsed: true,
    id: "1",
    latestLedger: 100,
    minResourceFee,
    events: Array.from({ length: eventCount }, (_, i) => ({ id: `evt-${i}` })) as never,
    transactionData: {
      build: () => ({
        resources: () => ({
          instructions: () => 1_000,
          readBytes: () => 512,
          writeBytes: () => 256,
        }),
      }),
    } as never,
  };
}

function makeErrorResponse(): SorobanRpc.Api.SimulateTransactionErrorResponse {
  return {
    _parsed: true,
    id: "1",
    latestLedger: 100,
    error: "simulation failed",
    events: [],
  };
}

describe("diffSimulations", () => {
  it("returns all-zero deltas for identical simulations", () => {
    const sim = makeSuccessResponse("1000", 2);
    const result = diffSimulations(sim, sim) as SimulationDiffSuccess;

    expect(result.comparable).toBe(true);
    expect(result.feeDelta).toBe(0n);
    expect(result.eventsAdded).toBe(0);
    expect(result.eventsRemoved).toBe(0);
    expect(result.resourceDelta.cpuInstructions).toBe(0n);
  });

  it("detects a fee increase between before and after", () => {
    const before = makeSuccessResponse("1000", 0);
    const after = makeSuccessResponse("1500", 0);
    const result = diffSimulations(before, after) as SimulationDiffSuccess;

    expect(result.comparable).toBe(true);
    expect(result.feeDelta).toBe(500n);
  });

  it("counts added and removed events correctly", () => {
    const before = makeSuccessResponse("1000", 3);
    const after = makeSuccessResponse("1000", 5);
    const result = diffSimulations(before, after) as SimulationDiffSuccess;

    expect(result.eventsAdded).toBe(2);
    expect(result.eventsRemoved).toBe(0);
  });

  it("returns comparable: false when before is an error response", () => {
    const err = makeErrorResponse();
    const ok = makeSuccessResponse("1000", 0);
    const result = diffSimulations(err, ok);

    expect(result.comparable).toBe(false);
  });

  it("returns comparable: false when after is an error response", () => {
    const ok = makeSuccessResponse("1000", 0);
    const err = makeErrorResponse();
    const result = diffSimulations(ok, err);

    expect(result.comparable).toBe(false);
    if (!result.comparable) {
      expect(result.reason).toMatch(/after/);
    }
  });
});
