/**
 * Error recovery strategies for StellarSplit SDK (issue #1068).
 *
 * Maps every {@link SdkErrorCode} (issue #1067) to a concrete recovery
 * strategy describing what a caller should do when that failure occurs:
 * retry as-is, retry with backoff, refresh state and rebuild, correct the
 * input, switch to a fallback endpoint, wait for external state to change,
 * or abort.
 *
 * The mapping is exhaustive by construction — adding a new error code without
 * declaring its recovery strategy is a compile error.
 *
 * @example Inspect the strategy for an error
 * ```ts
 * import { getRecoveryPlan } from "@stellar-split/sdk";
 *
 * try {
 *   await client.pay(invoiceId, amount);
 * } catch (err) {
 *   const plan = getRecoveryPlan(err);
 *   console.log(plan.strategy.action);  // e.g. "retry_with_backoff"
 *   console.log(plan.suggestion);       // human-readable remediation
 * }
 * ```
 *
 * @example Automatic recovery
 * ```ts
 * import { executeWithRecovery } from "@stellar-split/sdk";
 *
 * const result = await executeWithRecovery(() => client.getInvoice(invoiceId), {
 *   onRetry: (attempt, strategy) => console.warn(`Retry ${attempt}: ${strategy.description}`),
 * });
 * ```
 */

import {
  SdkError,
  SdkErrorCode,
  StellarSplitError,
} from "./errors.js";
import { getSuggestion } from "./errorSuggestions.js";
import { isRetryableErrorCode } from "./errorCodes.js";

/** The category of remediation recommended for a failure. */
export type RecoveryAction =
  /** Safe to re-issue the same request immediately. */
  | "retry"
  /** Re-issue after an exponential backoff delay (rate limits, congestion). */
  | "retry_with_backoff"
  /** Refresh on-chain/network state, rebuild the request, then retry. */
  | "refresh_and_retry"
  /** Fix the caller's input; retrying unchanged will fail again. */
  | "correct_input"
  /** Switch to a fallback RPC/Horizon endpoint or provider. */
  | "use_fallback"
  /** External state (dispute, freeze, cooldown) must change before retrying. */
  | "wait_for_resolution"
  /** Terminal failure — do not retry. */
  | "abort";

/** A concrete recovery strategy for one error code. */
export interface RecoveryStrategy {
  /** What the caller should do when this failure occurs. */
  action: RecoveryAction;
  /** Whether re-issuing the same request is safe at all. */
  retryable: boolean;
  /** Maximum attempts to apply the strategy (when retrying). */
  maxAttempts?: number;
  /** Base delay in ms between attempts; doubled after each failure. */
  backoffMs?: number;
  /** Human-readable explanation of the strategy. */
  description: string;
}

/**
 * Recovery strategy for every {@link SdkErrorCode}.
 *
 * Retryable network codes (`NETWORK_TIMEOUT`, `RATE_LIMITED`, ...) retry with
 * exponential backoff. State-dependent failures (`SEQUENCE_MISMATCH`,
 * `TRANSACTION_EXPIRED`) require re-fetching state and rebuilding the
 * transaction. Input and authorization failures are terminal until the caller
 * changes something, so they never retry automatically.
 */
export const RECOVERY_STRATEGY_TABLE: Record<SdkErrorCode, RecoveryStrategy> = {
  // Invoice / resource lifecycle
  [SdkErrorCode.INVOICE_NOT_FOUND]: {
    action: "correct_input",
    retryable: false,
    description:
      "The invoice does not exist on this network. Verify the invoice ID and network before retrying.",
  },
  [SdkErrorCode.INVOICE_NOT_PENDING]: {
    action: "wait_for_resolution",
    retryable: false,
    description:
      "The invoice is not Pending. Wait for its state to change (or pick an operation valid for its current state).",
  },
  [SdkErrorCode.DEADLINE_EXPIRED]: {
    action: "correct_input",
    retryable: false,
    description:
      "The invoice deadline passed. Create a new invoice with a future deadline; the old one cannot be revived.",
  },
  [SdkErrorCode.INVOICE_FROZEN]: {
    action: "wait_for_resolution",
    retryable: false,
    description:
      "The invoice is frozen by a dispute or lock. Wait for the dispute to resolve before retrying.",
  },
  // Accounts & funds
  [SdkErrorCode.ACCOUNT_NOT_FOUND]: {
    action: "correct_input",
    retryable: false,
    description:
      "The account does not exist on-chain. Fund it (minbalance + reserves) or fix the address.",
  },
  [SdkErrorCode.INSUFFICIENT_FUNDS]: {
    action: "correct_input",
    retryable: false,
    description:
      "The balance cannot cover the operation. Top up the account or reduce the amount before retrying.",
  },
  // Input validation
  [SdkErrorCode.INVALID_INPUT]: {
    action: "correct_input",
    retryable: false,
    description: "The input is invalid. Fix the reported fields; retrying unchanged will fail again.",
  },
  [SdkErrorCode.INVALID_ADDRESS]: {
    action: "correct_input",
    retryable: false,
    description:
      "An address failed StrKey validation. Correct the address (56 base32 chars, valid CRC16).",
  },
  [SdkErrorCode.INVALID_CONTRACT_ADDRESS]: {
    action: "correct_input",
    retryable: false,
    description:
      "The contract address failed StrKey validation. Correct it or regenerate with StrKey.encodeContract().",
  },
  [SdkErrorCode.INVALID_AMOUNT]: {
    action: "correct_input",
    retryable: false,
    description: "The amount is malformed or out of range. Correct the amount before retrying.",
  },
  [SdkErrorCode.INVALID_RECIPIENT]: {
    action: "correct_input",
    retryable: false,
    description: "A recipient address is invalid. Fix the recipient list before retrying.",
  },
  [SdkErrorCode.INVALID_CONFIG]: {
    action: "correct_input",
    retryable: false,
    description: "The SDK configuration is invalid. Fix the reported config fields, then retry.",
  },
  // Network / transport
  [SdkErrorCode.NETWORK_ERROR]: {
    action: "use_fallback",
    retryable: true,
    maxAttempts: 3,
    backoffMs: 500,
    description:
      "Network-level failure. Retry with backoff; if it persists, fail over to a fallback RPC or Horizon endpoint.",
  },
  [SdkErrorCode.NETWORK_TIMEOUT]: {
    action: "retry_with_backoff",
    retryable: true,
    maxAttempts: 3,
    backoffMs: 500,
    description:
      "The request timed out. Retry with backoff; for submissions, check the transaction status by hash first.",
  },
  [SdkErrorCode.RPC_FAILED]: {
    action: "use_fallback",
    retryable: true,
    maxAttempts: 3,
    backoffMs: 500,
    description: "The RPC node failed. Retry with backoff or switch to a healthy fallback node.",
  },
  [SdkErrorCode.HORIZON_ERROR]: {
    action: "retry_with_backoff",
    retryable: true,
    maxAttempts: 3,
    backoffMs: 500,
    description:
      "Horizon returned an error. If the request is malformed, fix it; otherwise retry with backoff.",
  },
  [SdkErrorCode.SERVICE_UNAVAILABLE]: {
    action: "use_fallback",
    retryable: true,
    maxAttempts: 5,
    backoffMs: 1_000,
    description: "The endpoint is unavailable. Wait for recovery or switch to a fallback endpoint.",
  },
  [SdkErrorCode.RATE_LIMITED]: {
    action: "retry_with_backoff",
    retryable: true,
    maxAttempts: 5,
    backoffMs: 1_000,
    description: "Rate limited. Back off exponentially and retry; reduce request concurrency.",
  },
  // Transaction lifecycle
  [SdkErrorCode.TRANSACTION_FAILED]: {
    action: "abort",
    retryable: false,
    description:
      "The transaction failed on-chain. Inspect the result/diagnostic events, fix the cause, and submit a new transaction.",
  },
  [SdkErrorCode.TRANSACTION_EXPIRED]: {
    action: "refresh_and_retry",
    retryable: false,
    description:
      "The transaction's time bounds elapsed. Re-fetch the account state and rebuild with fresh time bounds.",
  },
  [SdkErrorCode.SEQUENCE_MISMATCH]: {
    action: "refresh_and_retry",
    retryable: false,
    description:
      "The sequence number is stale. Re-fetch the account sequence and rebuild the transaction before resubmitting.",
  },
  [SdkErrorCode.INSUFFICIENT_FEE]: {
    action: "refresh_and_retry",
    retryable: false,
    description:
      "The fee is too low. Rebuild with a higher base fee (and resource fee for Soroban), then resubmit.",
  },
  [SdkErrorCode.SUBMISSION_FAILED]: {
    action: "retry_with_backoff",
    retryable: true,
    maxAttempts: 3,
    backoffMs: 500,
    description:
      "Submission failed in transit. Retry submission with backoff, but check status by hash first to avoid double submission.",
  },
  [SdkErrorCode.CONFIRMATION_TIMEOUT]: {
    action: "refresh_and_retry",
    retryable: true,
    maxAttempts: 3,
    backoffMs: 1_000,
    description:
      "Confirmation timed out. Poll the transaction status by hash before deciding whether to rebuild and resubmit.",
  },
  [SdkErrorCode.VERIFICATION_FAILED]: {
    action: "correct_input",
    retryable: false,
    description:
      "Pre-submit verification failed. Fix the reported checks (signatures, fee, sequence, time bounds) and rebuild.",
  },
  [SdkErrorCode.MISSING_SIGNATURE]: {
    action: "correct_input",
    retryable: false,
    description: "A required signature is missing. Collect the missing signatures, then resubmit.",
  },
  [SdkErrorCode.INVALID_SIGNATURE]: {
    action: "correct_input",
    retryable: false,
    description: "A signature failed verification. Re-sign with the correct key over the exact hash.",
  },
  // Soroban contract execution
  [SdkErrorCode.CONTRACT_NOT_FOUND]: {
    action: "correct_input",
    retryable: false,
    description: "The contract does not exist on this network. Verify the contract ID and network.",
  },
  [SdkErrorCode.CONTRACT_REJECTED]: {
    action: "abort",
    retryable: false,
    description:
      "The contract rejected the invocation. Inspect the panic code/diagnostics and fix the call; do not blind-retry.",
  },
  [SdkErrorCode.SIMULATION_FAILED]: {
    action: "correct_input",
    retryable: false,
    description:
      "Simulation failed. Fix the invocation parameters or storage prerequisites, then resimulate.",
  },
  [SdkErrorCode.OUT_OF_RESOURCE]: {
    action: "refresh_and_retry",
    retryable: false,
    description:
      "Resource budget exceeded. Raise the resource fee/limits (or reduce the work done) and resimulate.",
  },
  // Authorization
  [SdkErrorCode.UNAUTHORIZED]: {
    action: "correct_input",
    retryable: false,
    description: "The signer lacks permission. Sign with an authorized account or grant the role first.",
  },
  [SdkErrorCode.WALLET_NOT_CONNECTED]: {
    action: "refresh_and_retry",
    retryable: false,
    description: "No wallet is connected. Reconnect the wallet, then retry the operation.",
  },
  [SdkErrorCode.AUTHENTICATION_FAILED]: {
    action: "refresh_and_retry",
    retryable: false,
    description: "Authentication failed. Re-authenticate with the wallet/signer, then retry.",
  },
  // Operational / state
  [SdkErrorCode.STATE_CONFLICT]: {
    action: "refresh_and_retry",
    retryable: false,
    description: "On-chain state changed underneath you. Re-fetch, reapply, and retry.",
  },
  [SdkErrorCode.CIRCUIT_OPEN]: {
    action: "wait_for_resolution",
    retryable: false,
    description: "The circuit breaker is open. Wait for the cooldown window before sending more calls.",
  },
  [SdkErrorCode.OPERATION_ABORTED]: {
    action: "retry",
    retryable: true,
    maxAttempts: 2,
    backoffMs: 250,
    description: "The operation was aborted before completion. Verify no partial state, then retry once.",
  },
  [SdkErrorCode.BATCH_TOO_LARGE]: {
    action: "correct_input",
    retryable: false,
    description:
      "The batch exceeds the maximum size. Split it into smaller chunks and process sequentially.",
  },
  [SdkErrorCode.INTERNAL_ERROR]: {
    action: "retry_with_backoff",
    retryable: true,
    maxAttempts: 2,
    backoffMs: 500,
    description: "Internal SDK error. Retry once with backoff; report the issue if it persists.",
  },
};

/**
 * Conservative strategy for errors without a known {@link SdkErrorCode}
 * (plain `Error`s, unparsed payloads). Unknown failures are assumed transient
 * and retried a limited number of times with backoff.
 */
const GENERIC_RECOVERY_STRATEGY: RecoveryStrategy = {
  action: "retry_with_backoff",
  retryable: true,
  maxAttempts: 3,
  backoffMs: 500,
  description:
    "Unknown error. Retry with backoff a limited number of times; if it persists, treat it as terminal.",
};

/** Extract the SdkErrorCode carried by an error, if it has one. */
function extractCode(error: SdkErrorCode | string | Error): SdkErrorCode | null {
  let raw: string;
  if (typeof error === "string") {
    raw = error;
  } else if (error instanceof SdkError || error instanceof StellarSplitError) {
    raw = String(error.code);
  } else {
    return null;
  }
  const normalized = raw.toUpperCase() as SdkErrorCode;
  return normalized in RECOVERY_STRATEGY_TABLE ? normalized : null;
}

/**
 * Resolve the recovery strategy for an error code, code string, or error
 * instance.
 *
 * - {@link SdkError} and {@link StellarSplitError}s resolve against
 *   {@link RECOVERY_STRATEGY_TABLE} via their `code` (case-insensitive).
 * - Code strings resolve against the same table.
 * - Everything else resolves to a conservative generic strategy that retries
 *   with backoff a limited number of times.
 *
 * @param error - An SdkErrorCode, a code string, or any Error instance.
 */
export function getRecoveryStrategy(error: SdkErrorCode | string | Error): RecoveryStrategy {
  const code = extractCode(error);
  return code ? RECOVERY_STRATEGY_TABLE[code] : GENERIC_RECOVERY_STRATEGY;
}

/** A resolved recovery plan: strategy plus human-readable remediation. */
export interface RecoveryPlan {
  /** The error code the plan was resolved from, when one could be identified. */
  code: SdkErrorCode | null;
  /** The recovery strategy to apply. */
  strategy: RecoveryStrategy;
  /** Human-readable remediation suggestion (via {@link getSuggestion}). */
  suggestion: string;
}

/**
 * Build a complete recovery plan for an error: the mapped
 * {@link RecoveryStrategy} plus a human-readable remediation suggestion.
 *
 * @param error - An SdkErrorCode, a code string, or any Error instance.
 *
 * @example
 * ```ts
 * const plan = getRecoveryPlan(err);
 * telemetry.track("recovery_plan", { code: plan.code, action: plan.strategy.action });
 * showUserError(plan.suggestion);
 * ```
 */
export function getRecoveryPlan(error: SdkErrorCode | string | Error): RecoveryPlan {
  return {
    code: extractCode(error),
    strategy: getRecoveryStrategy(error),
    suggestion: getSuggestion(error),
  };
}

/** Options for {@link executeWithRecovery}. */
export interface RecoveryRunOptions {
  /** Code assumed for thrown errors that do not carry one. */
  code?: SdkErrorCode;
  /** Abort signal checked before each retry. */
  signal?: AbortSignal;
  /** Override the sleep implementation (useful in tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Invoked before each backoff delay with the 1-based retry attempt number. */
  onRetry?: (attempt: number, strategy: RecoveryStrategy) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Backoff configuration for {@link runWithRecovery}. */
export interface BackoffOptions {
  /** Base delay in ms before the first retry. Defaults to the strategy's `backoffMs` or 500. */
  baseDelayMs?: number;
  /** Upper bound in ms for any single delay. Defaults to 30_000. */
  maxDelayMs?: number;
  /** Exponential growth factor applied per attempt. Defaults to 2. */
  multiplier?: number;
  /**
   * Jitter fraction in `[0, 1]` applied to each delay to avoid thundering
   * herds. `0` disables jitter; `1` randomizes the delay within `[0, delay]`.
   * Defaults to 0.2.
   */
  jitter?: number;
}

/** Hooks invoked by {@link runWithRecovery}. */
export interface RecoveryHooks {
  /** Called before each retry with the 1-based attempt, error, and delay. */
  beforeRetry?: (
    attempt: number,
    error: unknown,
    delayMs: number,
    strategy: RecoveryStrategy,
  ) => void | Promise<void>;
  /** Called once when the operation ultimately succeeds. */
  onSuccess?: (result: unknown, attempts: number) => void | Promise<void>;
  /** Called once when the operation ultimately fails (non-retryable or exhausted). */
  onFailure?: (error: unknown, attempts: number) => void | Promise<void>;
}

/** Options for {@link runWithRecovery}. */
export interface RecoveryRunnerOptions extends RecoveryHooks, BackoffOptions {
  /** Code assumed for thrown errors that do not carry one. */
  code?: SdkErrorCode;
  /** Abort signal checked before each attempt and during backoff. */
  signal?: AbortSignal;
  /** Override the sleep implementation (useful in tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Override the maximum number of attempts (overrides the strategy's `maxAttempts`). */
  maxAttempts?: number;
  /** Override the random source for jitter (useful in tests). Defaults to `Math.random`. */
  random?: () => number;
}

/** Aggregate statistics tracked across all {@link runWithRecovery} calls. */
export interface RecoveryStats {
  /** Total operations run. */
  operations: number;
  /** Total attempts made across all operations (including first attempts). */
  attempts: number;
  /** Operations that ultimately succeeded. */
  successes: number;
  /** Operations that ultimately failed. */
  failures: number;
  /** Total retries performed (attempts beyond the first). */
  retries: number;
  /** Total time spent in backoff delays, in ms. */
  totalBackoffMs: number;
  /** Total wall-clock time spent across all operations, in ms. */
  totalTimeMs: number;
}

const EMPTY_STATS: RecoveryStats = {
  operations: 0,
  attempts: 0,
  successes: 0,
  failures: 0,
  retries: 0,
  totalBackoffMs: 0,
  totalTimeMs: 0,
};

let recoveryStats: RecoveryStats = { ...EMPTY_STATS };

/** Snapshot of the recovery statistics accumulated so far. */
export function getRecoveryStats(): RecoveryStats {
  return { ...recoveryStats };
}

/** Reset the accumulated recovery statistics to zero. */
export function resetRecoveryStats(): void {
  recoveryStats = { ...EMPTY_STATS };
}

/**
 * Classify an error as transient (safe to retry) or permanent.
 *
 * An error is transient when its code is retryable per
 * {@link isRetryableErrorCode} and its mapped {@link RecoveryStrategy} is
 * `retryable`. Unknown errors fall back to the conservative generic strategy.
 */
export function isTransientError(
  error: SdkErrorCode | string | Error,
  fallbackCode?: SdkErrorCode,
): boolean {
  const code = extractCode(error) ?? fallbackCode ?? null;
  if (code === null) {
    return GENERIC_RECOVERY_STRATEGY.retryable;
  }
  if (!isRetryableErrorCode(code)) {
    return false;
  }
  return RECOVERY_STRATEGY_TABLE[code].retryable;
}

/** Compute the backoff delay for a 1-based retry attempt. */
function computeBackoff(
  attempt: number,
  strategy: RecoveryStrategy,
  options: BackoffOptions,
  random: () => number,
): number {
  const base = options.baseDelayMs ?? strategy.backoffMs ?? 500;
  const multiplier = options.multiplier ?? 2;
  const maxDelay = options.maxDelayMs ?? 30_000;
  const jitter = Math.min(Math.max(options.jitter ?? 0.2, 0), 1);

  const raw = base * multiplier ** (attempt - 1);
  const capped = Math.min(raw, maxDelay);
  if (jitter === 0) {
    return Math.round(capped);
  }
  const spread = capped * jitter;
  const min = capped - spread;
  return Math.round(min + random() * spread);
}

/**
 * Execute an async operation with automatic recovery for transient failures.
 *
 * - Transient errors are retried with exponential backoff and jitter, up to
 *   `maxAttempts` (defaults to the strategy's `maxAttempts`, else 3).
 * - Permanent (non-retryable) errors rethrow immediately.
 * - `beforeRetry`, `onSuccess`, and `onFailure` hooks are invoked at the
 *   appropriate points.
 * - An aborted `signal` stops retrying and rethrows the last error.
 * - Aggregate statistics are recorded and exposed via {@link getRecoveryStats}.
 *
 * @param op - The async operation to run.
 * @param options - Backoff, hook, abort, and override configuration.
 * @throws The last error when the operation fails permanently or exhausts retries.
 *
 * @example
 * ```ts
 * const invoice = await runWithRecovery(() => client.getInvoice(id), {
 *   maxAttempts: 5,
 *   baseDelayMs: 250,
 *   beforeRetry: (n, err, delay) => console.warn(`Retry ${n} in ${delay}ms`, err),
 * });
 * ```
 */
export async function runWithRecovery<T>(
  op: () => Promise<T>,
  options: RecoveryRunnerOptions = {},
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const startedAt = Date.now();

  let attempt = 0;
  let backoffTotal = 0;

  recoveryStats.operations += 1;

  for (;;) {
    attempt += 1;
    recoveryStats.attempts += 1;

    try {
      const result = await op();
      recoveryStats.successes += 1;
      recoveryStats.totalBackoffMs += backoffTotal;
      recoveryStats.totalTimeMs += Date.now() - startedAt;
      await options.onSuccess?.(result, attempt);
      return result;
    } catch (err) {
      const errCode =
        err instanceof SdkError ? err.code : (options.code ?? null);
      const strategy = errCode
        ? RECOVERY_STRATEGY_TABLE[errCode]
        : GENERIC_RECOVERY_STRATEGY;

      const transient = isTransientError(err as Error, options.code);
      const maxAttempts = options.maxAttempts ?? strategy.maxAttempts ?? 3;
      const canRetry = transient && attempt < maxAttempts;

      if (!canRetry || options.signal?.aborted) {
        recoveryStats.failures += 1;
        recoveryStats.totalBackoffMs += backoffTotal;
        recoveryStats.totalTimeMs += Date.now() - startedAt;
        await options.onFailure?.(err, attempt);
        throw err;
      }

      const delayMs = computeBackoff(attempt, strategy, options, random);
      recoveryStats.retries += 1;
      backoffTotal += delayMs;

      await options.beforeRetry?.(attempt, err, delayMs, strategy);
      await sleep(delayMs);
    }
  }
}

/**
 * Execute an async operation, automatically applying the recovery strategy
 * mapped to the error it throws.
 *
 * - Non-retryable strategies rethrow immediately.
 * - Retryable strategies re-invoke `op` up to `strategy.maxAttempts` times
 *   with exponential backoff (`backoffMs * 2^(attempt - 1)`).
 * - If `op` throws an {@link SdkError} its code selects the strategy; other
 *   errors use `options.code` when provided, else the conservative generic
 *   strategy.
 *
 * Delegates to {@link runWithRecovery}.
 *
 * @param op - The async operation to run.
 * @param options - Retry/abort configuration.
 * @throws The last error when every attempt fails (or the error is
 *   non-retryable).
 *
 * @example
 * ```ts
 * const invoice = await executeWithRecovery(
 *   () => client.getInvoice(invoiceId),
 *   { onRetry: (n, s) => console.warn(`Attempt ${n} failed: ${s.description}`) },
 * );
 * ```
 */
export async function executeWithRecovery<T>(
  op: () => Promise<T>,
  options: RecoveryRunOptions = {},
): Promise<T> {
  return runWithRecovery(op, {
    code: options.code,
    signal: options.signal,
    sleep: options.sleep,
    beforeRetry: options.onRetry
      ? (attempt, _err, _delay, strategy) => options.onRetry!(attempt, strategy)
      : undefined,
  });
}

