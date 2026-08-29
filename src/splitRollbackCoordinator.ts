/**
 * Coordinates rollback/reconciliation of multi-recipient split payments.
 *
 * A split payment groups several `pay` operations for one invoice into a
 * single transaction envelope (see `submitPayment`'s waterfall path). The
 * on-chain submission is atomic, but application-layer acknowledgement of
 * each leg (webhooks, database writes) can still partially fail after the
 * transaction lands. `RollbackCoordinator` records the intended legs of a
 * split as a checkpoint, lets callers mark each leg's outcome, and exposes
 * `initiateRollback` to identify legs that still need corrective action.
 */

import { IdempotencyManager } from "./idempotency.js";
import { snapshotSplitRollback, type SplitRollbackRecord } from "./snapshot.js";
import { UnknownSplitError } from "./errors.js";
import { TypedEventEmitter } from "./events/TypedEventEmitter.js";
import type { SplitLeg, SplitLegState, SplitRollbackCheckpoint } from "./types.js";

export class RollbackTimeoutError extends Error {
  constructor(splitId: string) {
    super(`Rollback timed out for split ${splitId}`);
    this.name = "RollbackTimeoutError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface RollbackTimeoutOptions {
  timeoutMs: number;
  execute: () => Promise<void>;
  cleanup?: () => Promise<void> | void;
}

/** Event payloads emitted by {@link RollbackCoordinator}. */
export interface SplitRollbackEventMap {
  splitRollbackInitiated: { splitId: string; incomplete: SplitLeg[] };
  splitRollbackCompleted: { splitId: string; record: SplitRollbackRecord };
}

/**
 * Tracks per-leg acknowledgement state for split payments and coordinates
 * rollback when some legs are left in an unknown state.
 */
export class RollbackCoordinator extends TypedEventEmitter<SplitRollbackEventMap> {
  private readonly checkpoints = new Map<string, SplitRollbackCheckpoint>();
  private readonly rollbackRecords = new Map<string, SplitRollbackRecord>();
  private readonly idempotency: IdempotencyManager;

  constructor(idempotency: IdempotencyManager = new IdempotencyManager()) {
    super();
    this.idempotency = idempotency;
  }

  /**
   * Create a persistent rollback checkpoint recording all intended split
   * legs. Must be called before `markLegSuccess`/`markLegFailed`.
   */
  begin(
    splitId: string,
    invoiceId: string,
    legs: Array<{ recipient: string; amount: bigint }>,
  ): SplitRollbackCheckpoint {
    const checkpoint: SplitRollbackCheckpoint = {
      splitId,
      invoiceId,
      createdAt: Date.now(),
      legs: legs.map((leg) => ({ ...leg, state: "pending" as SplitLegState })),
    };
    this.checkpoints.set(splitId, checkpoint);
    return checkpoint;
  }

  /** Mark the leg at `legIndex` as successfully acknowledged. */
  markLegSuccess(splitId: string, legIndex: number): void {
    this.setLegState(splitId, legIndex, "succeeded");
  }

  /** Mark the leg at `legIndex` as confirmed failed. */
  markLegFailed(splitId: string, legIndex: number): void {
    this.setLegState(splitId, legIndex, "failed");
  }

  /** Legs that are neither confirmed succeeded nor confirmed failed. */
  getIncomplete(splitId: string): SplitLeg[] {
    return this.getCheckpoint(splitId).legs.filter((leg) => leg.state === "pending");
  }

  /**
   * Initiate a rollback for `splitId`: emits `splitRollbackInitiated` with
   * the current incomplete legs, persists a rollback record via
   * {@link snapshotSplitRollback}, then emits `splitRollbackCompleted`.
   *
   * Idempotent per `splitId` — calling this more than once returns the
   * originally stored record without re-emitting events.
   */
  initiateRollback(splitId: string): SplitRollbackRecord {
    const checkpoint = this.getCheckpoint(splitId);
    const key = this.idempotency.generateKey(splitId, "rollback");

    const existing = this.rollbackRecords.get(splitId);
    if (existing && this.idempotency.isDuplicate(key)) {
      return existing;
    }

    const incomplete = this.getIncomplete(splitId);
    this.emit("splitRollbackInitiated", { splitId, incomplete });

    const record = snapshotSplitRollback(checkpoint);
    this.rollbackRecords.set(splitId, record);
    this.idempotency.tryClaim(key, { txHash: record.snapshotId });

    this.emit("splitRollbackCompleted", { splitId, record });
    return record;
  }

  /** The persisted rollback record for `splitId`, if a rollback was initiated. */
  getRollbackRecord(splitId: string): SplitRollbackRecord | undefined {
    return this.rollbackRecords.get(splitId);
  }

  /** The current checkpoint for `splitId`, if one exists. */
  getCheckpointFor(splitId: string): SplitRollbackCheckpoint | undefined {
    return this.checkpoints.get(splitId);
  }

  async initiateRollbackWithTimeout(
    splitId: string,
    options: RollbackTimeoutOptions,
  ): Promise<SplitRollbackRecord> {
    const record = this.initiateRollback(splitId);

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new RollbackTimeoutError(splitId)), options.timeoutMs);
    });

    try {
      await Promise.race([options.execute(), timeoutPromise]);
      return record;
    } catch (error) {
      if (!(error instanceof RollbackTimeoutError)) {
        throw error;
      }

      await this.cleanupTimedOutRollback(splitId, options.cleanup);
      throw error;
    }
  }

  private getCheckpoint(splitId: string): SplitRollbackCheckpoint {
    const checkpoint = this.checkpoints.get(splitId);
    if (!checkpoint) throw new UnknownSplitError(splitId);
    return checkpoint;
  }

  private setLegState(splitId: string, legIndex: number, state: SplitLegState): void {
    const checkpoint = this.getCheckpoint(splitId);
    const leg = checkpoint.legs[legIndex];
    if (!leg) throw new UnknownSplitError(`${splitId}[${legIndex}]`);
    leg.state = state;
  }

  private async cleanupTimedOutRollback(
    splitId: string,
    cleanup?: () => Promise<void> | void,
  ): Promise<void> {
    this.rollbackRecords.delete(splitId);
    this.checkpoints.delete(splitId);

    if (!cleanup) {
      return;
    }

    try {
      await cleanup();
    } catch (error) {
      console.error("Rollback cleanup failed", error);
    }
  }
}
