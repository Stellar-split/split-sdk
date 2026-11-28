/**
 * Auto-recovery monitor for RPC endpoint health.
 *
 * Continuously monitors RPC health and automatically switches endpoints
 * when sustained failures are detected.
 */

import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import { checkRPCHealth } from "./health.js";
import { LoadBalancer } from "./loadBalancer.js";
import type { StellarSplitClient } from "./client.js";
import {
  ErrorRecoveryRunner,
  type RecoveryStats,
  type RecoveryStrategyOptions,
} from "./errorRecovery.js";

export interface AutoRecoveryOptions {
  failureThreshold?: number;
  pollingIntervalMs?: number;
  onSwitch?: (fromUrl: string, toUrl: string, reason: string) => void;
  /** Optional retry/backoff strategy used when switching endpoints. */
  recoveryStrategy?: RecoveryStrategyOptions;
}

/**
 * Monitor for RPC health with automatic endpoint switching.
 */
export class AutoRecoveryMonitor {
  private intervalId: NodeJS.Timeout | null = null;
  private readonly failureThreshold: number;
  private readonly pollingIntervalMs: number;
  private readonly onSwitch: (fromUrl: string, toUrl: string, reason: string) => void;
  private readonly recoveryRunner: ErrorRecoveryRunner;

  constructor(options: AutoRecoveryOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.pollingIntervalMs = options.pollingIntervalMs ?? 30_000;
    this.onSwitch = options.onSwitch ?? (() => {});
    this.recoveryRunner = new ErrorRecoveryRunner(options.recoveryStrategy);
  }

  /**
   * Snapshot of recovery statistics collected while switching endpoints.
   */
  getRecoveryStats(): RecoveryStats {
    return this.recoveryRunner.getStats();
  }

  /**
   * Start monitoring RPC health.
   *
   * @param client - StellarSplitClient instance with server and loadBalancer
   */
  async start(
    client: any
  ): Promise<void> {
    if (this.intervalId !== null) {
      return;
    }

    this.intervalId = setInterval(async () => {
      try {
        const health = await checkRPCHealth(client.server);

        if (health.status === "ok") {
          return;
        }

        const currentState = client.loadBalancer.getEndpointStates();
        for (const endpoint of currentState) {
          if (endpoint.consecutiveFailures >= this.failureThreshold && endpoint.healthy) {
            const reason = `Sustained unhealthy: ${health.status}`;
            try {
              await this.recoveryRunner.run(async () => {
                const nextEndpoint = client.loadBalancer.selectEndpoint();
                if (!nextEndpoint || nextEndpoint === endpoint.url) {
                  throw new Error("No alternative endpoint available");
                }
                this.onSwitch(endpoint.url, nextEndpoint, reason);
                return nextEndpoint;
              });
            } catch {
              // Recovery exhausted its retry budget; keep monitoring.
            }
          }
        }
      } catch {
        // Silently ignore monitoring errors
      }
    }, this.pollingIntervalMs);
  }

  /**
   * Stop monitoring RPC health.
   */
  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

/**
 * Lifecycle phase of a simulated transaction rollback.
 */
export type RollbackPhase = "start" | "success" | "failure";

export interface RollbackEvent {
  phase: RollbackPhase;
  transactionId: string;
  reason?: string;
  error?: Error;
  timestamp: number;
}

export interface RollbackSimulationOptions {
  /** Maximum number of simulated attempts before giving up. Defaults to 3. */
  maxAttempts?: number;
  /** Delay in ms between simulated attempts. Defaults to 0. */
  retryDelayMs?: number;
  /** Optional predicate deciding whether a given attempt should fail. */
  shouldFail?: (attempt: number, transactionId: string) => boolean;
  /** Optional hook invoked for every rollback lifecycle event. */
  onEvent?: (event: RollbackEvent) => void;
  /** Optional hook invoked at the start of each attempt (used by {@link TransactionRollbackSimulator.run}). */
  onStart?: (attempt: number) => void;
  /** Optional hook invoked when an attempt succeeds (used by {@link TransactionRollbackSimulator.run}). */
  onSuccess?: (attempt: number) => void;
  /** Optional hook invoked when an attempt fails (used by {@link TransactionRollbackSimulator.run}). */
  onFailure?: (attempt: number, error: Error) => void;
}

export interface RollbackSimulationResult {
  transactionId: string;
  success: boolean;
  attempts: number;
  rolledBack: boolean;
  error?: Error;
}

/**
 * Simulates the rollback of an SDK transaction, emitting lifecycle events
 * (start/success/failure) and reporting whether the transaction was rolled
 * back after exhausting its retry budget.
 */
export class TransactionRollbackSimulator {
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly shouldFail: (attempt: number, transactionId: string) => boolean;
  private readonly onEvent: (event: RollbackEvent) => void;
  private readonly onStart: (attempt: number) => void;
  private readonly onSuccess: (attempt: number) => void;
  private readonly onFailure: (attempt: number, error: Error) => void;

  constructor(options: RollbackSimulationOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 0;
    this.shouldFail = options.shouldFail ?? (() => false);
    this.onEvent = options.onEvent ?? (() => {});
    this.onStart = options.onStart ?? (() => {});
    this.onSuccess = options.onSuccess ?? (() => {});
    this.onFailure = options.onFailure ?? (() => {});
  }

  /**
   * Run an executor function under the configured retry/failure policy,
   * firing `onStart`/`onSuccess`/`onFailure` once per attempt. Unlike
   * {@link simulate}, this does not require a `transactionId` and treats a
   * `shouldFail` hit the same as a thrown error from `execute`.
   */
  async run(execute: () => Promise<unknown>): Promise<RollbackSimulationResult> {
    let attempts = 0;
    let lastError: Error | undefined;

    while (attempts < this.maxAttempts) {
      attempts += 1;
      this.onStart(attempts);
      try {
        if (this.shouldFail(attempts, "")) {
          throw new Error(`Simulated failure on attempt ${attempts}`);
        }
        await execute();
        this.onSuccess(attempts);
        return { transactionId: "", success: true, attempts, rolledBack: false };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.onFailure(attempts, lastError);
        if (attempts < this.maxAttempts) {
          await this.delay();
        }
      }
    }

    return { transactionId: "", success: false, attempts, rolledBack: true, error: lastError };
  }

  private emit(event: RollbackEvent): void {
    try {
      this.onEvent(event);
    } catch {
      // Listener errors must not break the simulation.
    }
  }

  private async delay(): Promise<void> {
    if (this.retryDelayMs <= 0) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, this.retryDelayMs));
  }

  /**
   * Run a rollback simulation for the given transaction id.
   *
   * @param transactionId - Identifier of the transaction being simulated
   * @param execute - Optional executor invoked per attempt; a thrown error
   *                  marks the attempt as failed.
   */
  async simulate(
    transactionId: string,
    execute?: (attempt: number) => Promise<void> | void
  ): Promise<RollbackSimulationResult> {
    this.emit({ phase: "start", transactionId, timestamp: Date.now() });

    let attempts = 0;
    let lastError: Error | undefined;

    while (attempts < this.maxAttempts) {
      attempts += 1;
      try {
        if (this.shouldFail(attempts, transactionId)) {
          throw new Error(`Simulated failure on attempt ${attempts}`);
        }
        if (execute) {
          await execute(attempts);
        }
        this.emit({ phase: "success", transactionId, timestamp: Date.now() });
        return { transactionId, success: true, attempts, rolledBack: false };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempts < this.maxAttempts) {
          await this.delay();
        }
      }
    }

    this.emit({
      phase: "failure",
      transactionId,
      reason: lastError?.message,
      error: lastError,
      timestamp: Date.now(),
    });

    return {
      transactionId,
      success: false,
      attempts,
      rolledBack: true,
      error: lastError,
    };
  }
}
