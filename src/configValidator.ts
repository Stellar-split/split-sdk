import type { StellarSplitClientConfig } from "./client.js";
import { isValidAddress } from "./utils.js";
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

export function validateClientConfig(
  config: StellarSplitClientConfig
): ConfigValidation {
  const errors: ConfigValidationErrorType[] = [];

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
    if (
      config.retry.maxRetries !== undefined &&
      typeof config.retry.maxRetries !== "number"
    ) {
      errors.push({
        field: "retry.maxRetries",
        message: "retry.maxRetries must be a number",
        severity: "error",
      });
    }

    if (
      config.retry.baseDelayMs !== undefined &&
      typeof config.retry.baseDelayMs !== "number"
    ) {
      errors.push({
        field: "retry.baseDelayMs",
        message: "retry.baseDelayMs must be a number",
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

  if (config.sponsorAccount && !isValidAddress(config.sponsorAccount)) {
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

    throw new ConfigValidationError(parts.join("\n"), validation.errors);
  }
}

export class ConfigValidationError extends StellarSplitError {
  readonly validationErrors: ConfigValidationErrorType[];

  constructor(message: string, validationErrors: ConfigValidationErrorType[]) {
    super(message, "CONFIG_VALIDATION_ERROR", { fieldErrors: validationErrors.length }, message);
    this.name = "ConfigValidationError";
    this.validationErrors = validationErrors;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
