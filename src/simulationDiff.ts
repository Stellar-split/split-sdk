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

// ---------------------------------------------------------------------------
// compareSimulations — structured baseline-vs-revised comparator
// ---------------------------------------------------------------------------

/**
 * Structured comparison between a baseline and a revised simulation run.
 * Positive deltas mean the revised simulation uses more resources.
 */
export interface SimulationComparison {
  comparable: true;
  /** Difference in CPU instructions (revised − baseline). */
  cpuDelta: bigint;
  /** Difference in combined read+write bytes (revised − baseline). */
  memDelta: bigint;
  /** Difference in minResourceFee, in stroops (revised − baseline). */
  feeDelta: bigint;
  /** LedgerKey XDR (base64) present in the revised footprint but not the baseline. */
  footprintAdded: string[];
  /** LedgerKey XDR (base64) present in the baseline footprint but not the revised. */
  footprintRemoved: string[];
  /** True when the set of Soroban authorization entries differs between runs. */
  authChanged: boolean;
}

/** Returned when either simulation cannot be compared (error or restore response). */
export interface SimulationComparisonNotComparable {
  comparable: false;
  reason: string;
}

function footprintKeys(response: SorobanRpc.Api.SimulateTransactionSuccessResponse): {
  readOnly: string[];
  readWrite: string[];
} {
  try {
    return {
      readOnly: response.transactionData.getReadOnly().map((key) => key.toXDR("base64")),
      readWrite: response.transactionData.getReadWrite().map((key) => key.toXDR("base64")),
    };
  } catch {
    return { readOnly: [], readWrite: [] };
  }
}

function authFingerprint(response: SorobanRpc.Api.SimulateTransactionSuccessResponse): string[] {
  const entries = response.result?.auth ?? [];
  return entries.map((entry) => entry.toXDR("base64")).sort();
}

/**
 * Compare two simulation runs (e.g. a baseline vs. a modified transaction)
 * and report exactly what changed in resource consumption, footprint, and
 * authorization entries.
 *
 * If either response is an error or a restore response, returns
 * `{ comparable: false }` instead of throwing.
 */
export function compareSimulations(
  baseline: SorobanRpc.Api.SimulateTransactionResponse,
  revised: SorobanRpc.Api.SimulateTransactionResponse,
): SimulationComparison | SimulationComparisonNotComparable {
  if (SorobanRpc.Api.isSimulationError(baseline)) {
    return { comparable: false, reason: "baseline simulation returned an error" };
  }
  if (SorobanRpc.Api.isSimulationError(revised)) {
    return { comparable: false, reason: "revised simulation returned an error" };
  }
  if (SorobanRpc.Api.isSimulationRestore(baseline)) {
    return { comparable: false, reason: "baseline simulation requires state restore" };
  }
  if (SorobanRpc.Api.isSimulationRestore(revised)) {
    return { comparable: false, reason: "revised simulation requires state restore" };
  }

  const baselineRes = resourceStats(baseline);
  const revisedRes = resourceStats(revised);

  const baselineFootprint = footprintKeys(baseline);
  const revisedFootprint = footprintKeys(revised);
  const baselineKeys = new Set([...baselineFootprint.readOnly, ...baselineFootprint.readWrite]);
  const revisedKeys = new Set([...revisedFootprint.readOnly, ...revisedFootprint.readWrite]);

  const footprintAdded = [...revisedKeys].filter((key) => !baselineKeys.has(key));
  const footprintRemoved = [...baselineKeys].filter((key) => !revisedKeys.has(key));

  const baselineAuth = authFingerprint(baseline);
  const revisedAuth = authFingerprint(revised);
  const authChanged = JSON.stringify(baselineAuth) !== JSON.stringify(revisedAuth);

  return {
    comparable: true,
    cpuDelta: revisedRes.cpuInstructions - baselineRes.cpuInstructions,
    memDelta:
      revisedRes.readBytes + revisedRes.writeBytes - (baselineRes.readBytes + baselineRes.writeBytes),
    feeDelta: bigintFee(revised) - bigintFee(baseline),
    footprintAdded,
    footprintRemoved,
    authChanged,
  };
}

/**
 * Produce a human-readable, multi-line summary of a {@link SimulationComparison}
 * suitable for logging.
 */
export function formatDiffSummary(diff: SimulationComparison | SimulationComparisonNotComparable): string {
  if (!diff.comparable) {
    return `Simulations not comparable: ${diff.reason}`;
  }

  const lines = [
    `CPU instructions: ${diff.cpuDelta >= 0n ? "+" : ""}${diff.cpuDelta}`,
    `Memory (read+write bytes): ${diff.memDelta >= 0n ? "+" : ""}${diff.memDelta}`,
    `Resource fee: ${diff.feeDelta >= 0n ? "+" : ""}${diff.feeDelta} stroops`,
    `Footprint added: ${diff.footprintAdded.length}`,
    `Footprint removed: ${diff.footprintRemoved.length}`,
    `Auth entries changed: ${diff.authChanged}`,
  ];
  return lines.join("\n");
}
