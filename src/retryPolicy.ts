import {
  InvoiceNotFoundError,
  ValidationError,
  WalletNotConnectedError,
  RpcError,
  PaymentCooldownActiveError,
  RoundNotEndedError,
  WrongMilestoneError,
  NothingToClaimError,
  InvoiceExpiredError,
  PayerNotWhitelistedError,
  ContributionCapExceededError,
  ContractFrozenError,
  InvoiceFullyFundedError,
  DelegateLimitReachedError,
  InvoiceFrozenError,
  UnauthorizedError,
  CircuitOpenError,
  TransactionNotConfirmedError,
  InvalidContractAddressError,
  TransactionVerificationError,
  isRetryableErrorCode,
} from "./errors.js";

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
  retryIf?: (error: Error) => boolean;
}

export type PerMethodRetryOptions = Partial<RetryOptions>;

export function isRetryable(error: unknown): boolean {
  // Prefer the centralized error-code taxonomy when the error carries a code.
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) {
      return isRetryableErrorCode(code);
    }
  }

  // Fallback for uncoded errors: explicit classification by error type.
  if (error instanceof PaymentCooldownActiveError) return true;
  if (error instanceof CircuitOpenError) return true;
  if (error instanceof TransactionNotConfirmedError) return true;
  if (error instanceof InvoiceNotFoundError) return false;
  if (error instanceof ValidationError) return false;
  if (error instanceof WalletNotConnectedError) return false;
  if (error instanceof InvoiceFrozenError) return false;
  if (error instanceof UnauthorizedError) return false;
  if (error instanceof RoundNotEndedError) return false;
  if (error instanceof WrongMilestoneError) return false;
  if (error instanceof NothingToClaimError) return false;
  if (error instanceof InvoiceExpiredError) return false;
  if (error instanceof PayerNotWhitelistedError) return false;
  if (error instanceof ContributionCapExceededError) return false;
  if (error instanceof ContractFrozenError) return false;
  if (error instanceof InvoiceFullyFundedError) return false;
  if (error instanceof DelegateLimitReachedError) return false;
  if (error instanceof InvalidContractAddressError) return false;
  if (error instanceof TransactionVerificationError) return false;

  if (error instanceof RpcError) {
    return error.statusCode === 429 || error.statusCode === 502 || error.statusCode === 503 || error.statusCode === 504;
  }

  if (!(error instanceof Error)) return false;

  const msg = error.message.toLowerCase();
  return (
    error.name === "AbortError" ||
    /timeout|timed out|network|failed to fetch|connection|connect|econnreset|econnrefused|eai_again|enotfound|429|502|503|504/.test(
      msg
    )
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
  methodOverride?: PerMethodRetryOptions
): Promise<T> {
  const maxAttempts = Math.max(1, methodOverride?.maxAttempts ?? options.maxAttempts);
  const baseDelayMs = methodOverride?.baseDelayMs ?? options.baseDelayMs;
  const maxDelayMs = methodOverride?.maxDelayMs ?? options.maxDelayMs;
  const onRetry = methodOverride?.onRetry ?? options.onRetry;
  const retryIf = methodOverride?.retryIf ?? options.retryIf;

  let lastError: unknown;
  let attemptsExhausted = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const isLast = attempt === maxAttempts - 1;
      if (!isRetryable(error)) break;
      if (error instanceof Error && retryIf && !retryIf(error)) break;
      if (isLast) {
        attemptsExhausted = true;
        break;
      }

      const jitter = Math.random() * baseDelayMs;
      const delayMs = Math.min(baseDelayMs * 2 ** attempt + jitter, maxDelayMs);
      onRetry?.(attempt + 1, error, delayMs);
      await sleep(delayMs);
    }
  }

  if (attemptsExhausted) {
    try {
      (lastError as Record<string, unknown>).retryExhausted = true;
    } catch {
      // frozen or sealed object — best-effort
    }
  }
  throw lastError;
}
