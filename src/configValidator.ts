import type { StellarSplitClientConfig } from "./client.js";
import { isValidStellarAddress } from "./utils.js";
import { StrKey } from "@stellar/stellar-sdk";
import { StellarSplitError } from "./errors.js";

export interface ConfigValidationErrorType {
  field: string;
  message: string;
  severity: "error" | "warning";
}

export interface ConfigValidation {
  valid: boolean;
  errors: ConfigValidationErrorType[];
}

const KNOWN_NETWORKS = [
  "Test SDF Network ; September 2015",
  "Public Global Stellar Network ; September 2015",
  "Standalone Network ; February 2017",
  "Soroban Future Network ; October 2024",
];

const KNOWN_CONFIG_KEYS = new Set([
  "rpcUrl",
  "networkPassphrase",
  "contractId",
  "adapter",
  "container",
  "signingKeypair",
  "retry",
  "maxRetries",
  "horizonUrl",
  "sponsorAccount",
  "cache",
  "hooks",
  "idempotency",
  "timeout",
  "degradation",
  "rateLimit",
  "telemetry",
  "traceIdGenerator",
  "signer",
  "validatePassphrase",
  "otel",
  "rpcClient",
  "adminKeypair",
  "dexContractId",
  "circuitBreaker",
  "optimisticCache",
  "offlineQueue",
  "logger",
]);

export class UnknownConfigKeyError extends StellarSplitError {
  readonly unknownKeys: string[];

  constructor(unknownKeys: string[]) {
    super(
      `Unknown configuration keys: ${unknownKeys.join(", ")}`,
      "UNKNOWN_CONFIG_KEY",
      { unknownKeys },
    );
    this.name = "UnknownConfigKeyError";
    this.unknownKeys = unknownKeys;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function validateClientConfig(
  config: StellarSplitClientConfig
): ConfigValidation {
  const errors: ConfigValidationErrorType[] = [];
  const unknownKeys = Object.keys(config).filter((key) => !KNOWN_CONFIG_KEYS.has(key));

  if (unknownKeys.length > 0) {
    errors.push({
      field: unknownKeys.join(","),
      message: `Unknown top-level config keys: ${unknownKeys.join(", ")}`,
      severity: "error",
    });
  }

  if (!config.rpcUrl) {
    errors.push({
      field: "rpcUrl",
      message: "rpcUrl is required but was not provided",
      severity: "error",
    });
  } else {
    const urls = Array.isArray(config.rpcUrl)
      ? config.rpcUrl
      : [config.rpcUrl];

    if (urls.length === 0) {
      errors.push({
        field: "rpcUrl",
        message: "rpcUrl array is empty — at least one endpoint is required",
        severity: "error",
      });
    }

    for (const url of urls) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          errors.push({
            field: "rpcUrl",
            message: `rpcUrl "${url}" must use http or https protocol`,
            severity: "error",
          });
        }
      } catch {
        errors.push({
          field: "rpcUrl",
          message: `rpcUrl "${url}" is not a valid URL`,
          severity: "error",
        });
      }
    }
  }

  if (!config.networkPassphrase) {
    errors.push({
      field: "networkPassphrase",
      message: "networkPassphrase is required but was not provided",
      severity: "error",
    });
  } else if (
    !KNOWN_NETWORKS.includes(config.networkPassphrase) &&
    config.networkPassphrase.length < 10
  ) {
    errors.push({
      field: "networkPassphrase",
      message: `networkPassphrase "${config.networkPassphrase}" looks unusual — expected a known Stellar network passphrase or a non-empty custom string`,
      severity: "warning",
    });
  }

  if (!config.contractId) {
    errors.push({
      field: "contractId",
      message: "contractId is required but was not provided",
      severity: "error",
    });
  } else {
    try {
      const decoded = StrKey.decodeContract(config.contractId);
      if (decoded.length !== 32) {
        errors.push({
          field: "contractId",
          message: `contractId "${config.contractId}" decoded to ${decoded.length} bytes, expected 32`,
          severity: "error",
        });
      }
    } catch {
      errors.push({
        field: "contractId",
        message: `contractId "${config.contractId}" is not a valid Stellar contract ID — expected a C... string`,
        severity: "error",
      });
    }
  }

  if (config.adapter && config.container?.getRPCClient && config.container.getRPCClient()) {
    errors.push({
      field: "adapter",
      message:
        "Both a wallet adapter and a DI container with an RPC client were provided. " +
        "When using a DI container, set the wallet adapter via container.getWalletAdapter() instead.",
      severity: "warning",
    });
  }

  if (
    config.adapter &&
    typeof config.adapter.getAddress !== "function"
  ) {
    errors.push({
      field: "adapter",
      message:
        "The provided wallet adapter is missing a getAddress() method. " +
        "Adapters must implement WalletAdapter { getAddress(): Promise<string>; signTransaction(xdr: string, network: string): Promise<string> }",
      severity: "error",
    });
  }

  if (
    config.adapter &&
    typeof config.adapter.signTransaction !== "function"
  ) {
    errors.push({
      field: "adapter",
      message:
        "The provided wallet adapter is missing a signTransaction() method. " +
        "Adapters must implement WalletAdapter { getAddress(): Promise<string>; signTransaction(xdr: string, network: string): Promise<string> }",
      severity: "error",
    });
  }

  if (config.signingKeypair && config.adapter) {
    errors.push({
      field: "signingKeypair",
      message:
        "Both signingKeypair and adapter are configured — signing requests may conflict. " +
        "Use signingKeypair for request signing or adapter for transaction signing, not both.",
      severity: "warning",
    });
  }

  if (config.retry) {
    if (typeof config.retry.maxAttempts !== "number" || config.retry.maxAttempts < 1) {
      errors.push({
        field: "retry.maxAttempts",
        message: "retry.maxAttempts must be a positive number",
        severity: "error",
      });
    }

    if (typeof config.retry.baseDelayMs !== "number" || config.retry.baseDelayMs < 0) {
      errors.push({
        field: "retry.baseDelayMs",
        message: "retry.baseDelayMs must be a non-negative number",
        severity: "error",
      });
    }

    if (typeof config.retry.maxDelayMs !== "number" || config.retry.maxDelayMs < 0) {
      errors.push({
        field: "retry.maxDelayMs",
        message: "retry.maxDelayMs must be a non-negative number",
        severity: "error",
      });
    }
  }

  if (config.maxRetries !== undefined && typeof config.maxRetries !== "number") {
    errors.push({
      field: "maxRetries",
      message: "maxRetries must be a number",
      severity: "error",
    });
  }

  if (config.horizonUrl) {
    try {
      new URL(config.horizonUrl);
    } catch {
      errors.push({
        field: "horizonUrl",
        message: `horizonUrl "${config.horizonUrl}" is not a valid URL`,
        severity: "error",
      });
    }
  }

  if (config.sponsorAccount && !isValidStellarAddress(config.sponsorAccount)) {
    errors.push({
      field: "sponsorAccount",
      message: `sponsorAccount "${config.sponsorAccount}" is not a valid Stellar G... address`,
      severity: "error",
    });
  }

  if (config.cache && typeof config.cache.ttlMs !== "number") {
    errors.push({
      field: "cache.ttlMs",
      message: "cache.ttlMs must be a number (milliseconds)",
      severity: "error",
    });
  }

  if (
    config.hooks &&
    typeof config.hooks !== "object"
  ) {
    errors.push({
      field: "hooks",
      message: "hooks must be an object implementing InvoiceLifecycleHooks",
      severity: "error",
    });
  }

  return {
    valid: errors.filter((e) => e.severity === "error").length === 0,
    errors,
  };
}

export function validateOrThrow(config: StellarSplitClientConfig): void {
  const validation = validateClientConfig(config);

  const unknownKeys = Object.keys(config).filter((key) => !KNOWN_CONFIG_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new UnknownConfigKeyError(unknownKeys);
  }

  if (!validation.valid) {
    const errorMessages = validation.errors
      .filter((e) => e.severity === "error")
      .map((e) => `  - ${e.field}: ${e.message}`);

    const warningMessages = validation.errors
      .filter((e) => e.severity === "warning")
      .map((e) => `  - ${e.field}: ${e.message}`);

    const parts: string[] = [
      `StellarSplitClientConfig validation failed with ${validation.errors.filter((e) => e.severity === "error").length} error(s):`,
      ...errorMessages,
    ];

    if (warningMessages.length > 0) {
      parts.push(
        "",
        `Warning(s):`,
        ...warningMessages,
      );
    }

    throw new InvalidConfigError(parts.join("\n"), validation.errors);
  }
}

export function validateConfig(config: StellarSplitClientConfig): void {
  validateOrThrow(config);
}

export class InvalidConfigError extends StellarSplitError {
  readonly validationErrors: ConfigValidationErrorType[];

  constructor(message: string, validationErrors: ConfigValidationErrorType[]) {
    super(message, "CONFIG_VALIDATION_ERROR", { fieldErrors: validationErrors.length }, message);
    this.name = "InvalidConfigError";
    this.validationErrors = validationErrors;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// #883 — ConfigurationError with structured field / value / hint fields
// ---------------------------------------------------------------------------

/**
 * The network shorthand accepted by {@link ConfigurationError} and the
 * enhanced strict validators.
 */
export type NetworkShorthand = "testnet" | "mainnet";

/** Map from shorthand to official Stellar network passphrases. */
export const NETWORK_PASSPHRASE_MAP: Record<NetworkShorthand, string> = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
};

/**
 * Structured configuration error that pinpoints exactly which field is wrong,
 * what value was supplied, and how to fix it.
 *
 * @example
 * ```ts
 * throw new ConfigurationError({
 *   field: 'rpcUrl',
 *   value: 'ftp://example.com',
 *   hint: 'rpcUrl must use the https:// scheme.',
 * });
 * ```
 */
export class ConfigurationError extends StellarSplitError {
  /** The name of the misconfigured field. */
  readonly field: string;
  /** The value that was supplied (stringified). */
  readonly value: unknown;
  /** A human-readable suggestion for how to fix the problem. */
  readonly hint: string;

  constructor(params: { field: string; value?: unknown; hint: string }) {
    const { field, value, hint } = params;
    const valueStr =
      value === undefined ? "(not provided)" : JSON.stringify(value);
    const message = `Configuration error on field "${field}": ${hint} (got ${valueStr})`;
    super(message, "CONFIGURATION_ERROR", { field, value, hint });
    this.name = "ConfigurationError";
    this.field = field;
    this.value = value;
    this.hint = hint;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Extended strict-validation helpers (required by issue #883)
// ---------------------------------------------------------------------------

/**
 * Validate a raw config object against the strict rules introduced in #883.
 *
 * Throws {@link ConfigurationError} on the first invalid field so the
 * developer gets a clear, actionable message.
 *
 * Rules checked (in order):
 *  1. `rpcUrl` — must be a valid **https** URL (http not allowed in strict mode)
 *  2. `contractId` — must be a valid Stellar C-address (56 chars, C-prefix)
 *  3. `network` — must be `"testnet"` or `"mainnet"` when provided
 *  4. `networkPassphrase` vs `network` — must match if both are provided
 */
export function validateConfigStrict(config: {
  rpcUrl: unknown;
  contractId: unknown;
  network?: unknown;
  networkPassphrase?: unknown;
}): void {
  // ---- rpcUrl ---------------------------------------------------------------
  if (!config.rpcUrl || typeof config.rpcUrl !== "string") {
    throw new ConfigurationError({
      field: "rpcUrl",
      value: config.rpcUrl,
      hint: "rpcUrl is required and must be a non-empty string with an https:// URL.",
    });
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(config.rpcUrl as string);
  } catch {
    throw new ConfigurationError({
      field: "rpcUrl",
      value: config.rpcUrl,
      hint: "rpcUrl must be a valid URL, e.g. https://soroban-testnet.stellar.org",
    });
  }

  if (parsedUrl.protocol !== "https:") {
    throw new ConfigurationError({
      field: "rpcUrl",
      value: config.rpcUrl,
      hint: `rpcUrl must use the https:// scheme. Received "${parsedUrl.protocol}". Example: https://soroban-testnet.stellar.org`,
    });
  }

  // ---- contractId -----------------------------------------------------------
  if (!config.contractId || typeof config.contractId !== "string") {
    throw new ConfigurationError({
      field: "contractId",
      value: config.contractId,
      hint: "contractId is required and must be a valid Stellar C-address (56 characters, starts with 'C').",
    });
  }

  if (
    !(config.contractId as string).startsWith("C") ||
    (config.contractId as string).length !== 56
  ) {
    throw new ConfigurationError({
      field: "contractId",
      value: config.contractId,
      hint: "contractId must be a 56-character Stellar contract address starting with 'C'. Use StrKey.encodeContract() to generate one.",
    });
  }

  try {
    StrKey.decodeContract(config.contractId as string);
  } catch {
    throw new ConfigurationError({
      field: "contractId",
      value: config.contractId,
      hint: "contractId failed Stellar StrKey validation. Ensure you are using a properly encoded C-address.",
    });
  }

  // ---- network --------------------------------------------------------------
  if (config.network !== undefined) {
    if (
      config.network !== "testnet" &&
      config.network !== "mainnet"
    ) {
      throw new ConfigurationError({
        field: "network",
        value: config.network,
        hint: 'network must be either "testnet" or "mainnet".',
      });
    }

    // ---- networkPassphrase vs network mismatch --------------------------------
    if (config.networkPassphrase !== undefined) {
      const expected =
        NETWORK_PASSPHRASE_MAP[config.network as NetworkShorthand];
      if (config.networkPassphrase !== expected) {
        throw new ConfigurationError({
          field: "networkPassphrase",
          value: config.networkPassphrase,
          hint: `networkPassphrase does not match the selected network "${config.network}". Expected: "${expected}"`,
        });
      }
    }
  }
}
