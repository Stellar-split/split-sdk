/**
 * simulationDiff — diff two Soroban simulation responses.
 *
 * Useful before resubmitting a tweaked or fee-bumped transaction: call
 * diffSimulations(before, after) to see what changed in fees, events, and
 * resource consumption without inspecting raw XDR by hand.
 */

import { rpc as SorobanRpc } from "@stellar/stellar-sdk";

export interface ResourceDelta {
  /** Difference in CPU instructions (after − before). */
  cpuInstructions: bigint;
  /** Difference in read-bytes (after − before). */
  readBytes: bigint;
  /** Difference in write-bytes (after − before). */
  writeBytes: bigint;
}

/** Returned when both inputs are valid, comparable simulation results. */
export interface SimulationDiffSuccess {
  comparable: true;
  /** Difference in minResourceFee expressed in stroops (after − before). */
  feeDelta: bigint;
  /** Number of diagnostic events that appear only in `after`. */
  eventsAdded: number;
  /** Number of diagnostic events that appear only in `before`. */
  eventsRemoved: number;
  resourceDelta: ResourceDelta;
}

/** Returned when at least one input is a simulation error or restore response. */
export interface SimulationDiffNotComparable {
  comparable: false;
  reason: string;
}

export type SimulationDiff = SimulationDiffSuccess | SimulationDiffNotComparable;

function bigintFee(response: SorobanRpc.Api.SimulateTransactionSuccessResponse): bigint {
  return BigInt(response.minResourceFee ?? "0");
}

function resourceStats(
  response: SorobanRpc.Api.SimulateTransactionSuccessResponse,
): { cpuInstructions: bigint; readBytes: bigint; writeBytes: bigint } {
  try {
    const resources = response.transactionData.build().resources();
    return {
      cpuInstructions: BigInt(resources.instructions()),
      readBytes: BigInt(resources.readBytes()),
      writeBytes: BigInt(resources.writeBytes()),
    };
  } catch {
    return { cpuInstructions: 0n, readBytes: 0n, writeBytes: 0n };
  }
}

/**
 * Diff two `SimulateTransactionResponse` objects.
 *
 * If either response is an error or a restore response, returns
 * `{ comparable: false }` instead of throwing.
 */
export function diffSimulations(
  before: SorobanRpc.Api.SimulateTransactionResponse,
  after: SorobanRpc.Api.SimulateTransactionResponse,
): SimulationDiff {
  if (SorobanRpc.Api.isSimulationError(before)) {
    return { comparable: false, reason: "before simulation returned an error" };
  }
  if (SorobanRpc.Api.isSimulationError(after)) {
    return { comparable: false, reason: "after simulation returned an error" };
  }
  if (SorobanRpc.Api.isSimulationRestore(before)) {
    return { comparable: false, reason: "before simulation requires state restore" };
  }
  if (SorobanRpc.Api.isSimulationRestore(after)) {
    return { comparable: false, reason: "after simulation requires state restore" };
  }

  const beforeFee = bigintFee(before);
  const afterFee = bigintFee(after);

  const beforeEvents = before.events ?? [];
  const afterEvents = after.events ?? [];
  const eventsAdded = Math.max(0, afterEvents.length - beforeEvents.length);
  const eventsRemoved = Math.max(0, beforeEvents.length - afterEvents.length);

  const beforeRes = resourceStats(before);
  const afterRes = resourceStats(after);

  return {
    comparable: true,
    feeDelta: afterFee - beforeFee,
    eventsAdded,
    eventsRemoved,
    resourceDelta: {
      cpuInstructions: afterRes.cpuInstructions - beforeRes.cpuInstructions,
      readBytes: afterRes.readBytes - beforeRes.readBytes,
      writeBytes: afterRes.writeBytes - beforeRes.writeBytes,
    },
  };
}
