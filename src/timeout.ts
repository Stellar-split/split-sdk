/**
 * Per-method timeout configuration and enforcement via AbortController.
 */

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Timeout config: keys are method names, values are milliseconds.
 * The special key "default" applies to any method not explicitly listed.
 */
export type TimeoutConfig =
  | number
  | ({ default?: number } & Record<string, number | undefined>);

/** Thrown when a request exceeds its configured timeout. */
export class RequestTimeoutError extends Error {
  readonly code = "REQUEST_TIMEOUT";
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms (method: ${method})`);
    this.name = "RequestTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const KNOWN_METHODS = [
  "getInvoice",
  "createInvoice",
  "pay",
  "batchPay",
  "getLeaderboard",
  "getInvoiceHistory",
  "getPaymentHistory",
  "getInvoicesByCreator",
  "getInvoicesByRecipient",
  "releaseInvoice",
  "cancelInvoice",
  "refundInvoice",
  "disputeInvoice",
  "checkNftGate",
  "verifyBatchPay",
  "simulateCreateInvoice",
  "simulatePay",
  "cloneInvoice",
  "syncInvoice",
  "checkRPCHealth",
];

export class TimeoutManager {
  private readonly _config: { default?: number } & Record<string, number | undefined>;

  constructor(config: TimeoutConfig) {
    if (typeof config === "number") {
      this._config = { default: config };
    } else {
      this._config = config;
    }
  }

  resolveTimeout(method: string): number {
    return this._config[method] ?? this._config.default ?? DEFAULT_TIMEOUT_MS;
  }

  getTimeoutConfig(): Record<string, number> {
    const defaultMs = this._config.default ?? DEFAULT_TIMEOUT_MS;
    const result: Record<string, number> = {};
    for (const method of KNOWN_METHODS) {
      result[method] = this._config[method] ?? defaultMs;
    }
    for (const key of Object.keys(this._config)) {
      if (key !== "default" && !(key in result)) {
        result[key] = this._config[key]!;
      }
    }
    return result;
  }
}

/**
 * Runs `fn` with a timeout enforced via AbortController.
 * If the timeout fires first, the controller is aborted and
 * RequestTimeoutError is thrown. The per-retry window resets on each call.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  method: string
): Promise<T> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new RequestTimeoutError(method, timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([fn(controller.signal), timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}
