/**
 * Network environment configuration for the StellarSplit SDK.
 *
 * Provides first-class presets for the well-known Stellar networks plus a
 * `CUSTOM` escape hatch, so callers can switch the active network at runtime
 * without rebuilding the client. The switcher itself lives on
 * {@link StellarSplitClient.switchNetwork} in `client.ts`.
 *
 * This module also exposes the configuration surface for the SDK's security
 * features: input sanitization (#1251), rate limiting (#1252), CSRF protection
 * (#1253) and secure key storage (#1254).
 */

import { Networks } from "@stellar/stellar-sdk";
import { UnknownNetworkError } from "./errors.js";

/** Well-known networks the SDK can be switched to. */
export enum NetworkEnvironment {
  /** Stellar public network ("mainnet"). */
  MAINNET = "mainnet",
  /** Stellar test network. */
  TESTNET = "testnet",
  /** Stellar future network. */
  FUTURENET = "futurenet",
  /** Bring-your-own network; requires an explicit {@link NetworkPreset}. */
  CUSTOM = "custom",
}

/**
 * A fully-qualified network configuration.
 *
 * Every field is required so the switcher can rebind both the Horizon and
 * Soroban RPC references and cross-check the passphrase in one step.
 */
export interface NetworkPreset {
  /** Horizon API base URL for the network. */
  horizonUrl: string;
  /** Soroban RPC endpoint URL for the network. */
  rpcUrl: string;
  /** Stellar network passphrase reported by the RPC node. */
  networkPassphrase: string;
}

/** Built-in presets for the three well-known Stellar networks. */
export const NETWORK_PRESETS: Record<
  Exclude<NetworkEnvironment, NetworkEnvironment.CUSTOM>,
  NetworkPreset
> = {
  [NetworkEnvironment.MAINNET]: {
    horizonUrl: "https://horizon.stellar.org",
    rpcUrl: "https://soroban-mainnet.stellar.org",
    networkPassphrase: Networks.PUBLIC,
  },
  [NetworkEnvironment.TESTNET]: {
    horizonUrl: "https://horizon-testnet.stellar.org",
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: Networks.TESTNET,
  },
  [NetworkEnvironment.FUTURENET]: {
    horizonUrl: "https://horizon-futurenet.stellar.org",
    rpcUrl: "https://rpc-futurenet.stellar.org",
    networkPassphrase: Networks.FUTURENET,
  },
};

/** Type guard for a caller-supplied {@link NetworkPreset}. */
export function isNetworkPreset(value: unknown): value is NetworkPreset {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<NetworkPreset>;
  return (
    typeof candidate.horizonUrl === "string" &&
    typeof candidate.rpcUrl === "string" &&
    typeof candidate.networkPassphrase === "string"
  );
}

/**
 * Resolves a built-in {@link NetworkEnvironment} to its preset.
 *
 * @throws {UnknownNetworkError} when no preset exists for the environment.
 */
export function getNetworkPreset(
  environment: Exclude<NetworkEnvironment, NetworkEnvironment.CUSTOM>,
): NetworkPreset {
  const preset = NETWORK_PRESETS[environment];
  if (!preset) {
    throw new UnknownNetworkError(String(environment));
  }
  return preset;
}

/**
 * Best-effort detection of the {@link NetworkEnvironment} for a passphrase.
 * Returns {@link NetworkEnvironment.CUSTOM} when the passphrase matches no
 * built-in preset.
 */
export function detectNetworkEnvironment(
  passphrase: string,
): NetworkEnvironment {
  for (const environment of Object.keys(NETWORK_PRESETS) as Array<
    Exclude<NetworkEnvironment, NetworkEnvironment.CUSTOM>
  >) {
    if (NETWORK_PRESETS[environment].networkPassphrase === passphrase) {
      return environment;
    }
  }
  return NetworkEnvironment.CUSTOM;
}

/* -------------------------------------------------------------------------- */
/* Security configuration (#1251 - #1254)                                     */
/* -------------------------------------------------------------------------- */

/**
 * Configuration for input sanitization (#1251).
 *
 * Controls how string inputs are normalized and which characters are rejected
 * before they reach any SDK method.
 */
export interface SanitizationConfig {
  /** Master switch for input sanitization. Defaults to `true`. */
  enabled?: boolean;
  /**
   * When `true`, inputs containing disallowed characters are rejected with an
   * error instead of being stripped. Defaults to `true`.
   */
  strict?: boolean;
  /**
   * Maximum accepted length for a single string input. Longer inputs are
   * rejected (strict) or truncated (non-strict). Defaults to `4096`.
   */
  maxLength?: number;
  /**
   * Characters that are always allowed in addition to the built-in safe set.
   * Useful for whitelisting domain-specific characters.
   */
  allowedCharacters?: string;
  /**
   * Explicit whitelist of field names whose values bypass sanitization.
   * Only use for values that are validated elsewhere.
   */
  whitelistFields?: string[];
  /** When `true`, sanitization events are recorded. Defaults to `true`. */
  trackEvents?: boolean;
}

/** Resolved sanitization configuration with all defaults applied. */
export interface ResolvedSanitizationConfig {
  enabled: boolean;
  strict: boolean;
  maxLength: number;
  allowedCharacters: string;
  whitelistFields: string[];
  trackEvents: boolean;
}

/** Default sanitization configuration. */
export const DEFAULT_SANITIZATION_CONFIG: ResolvedSanitizationConfig = {
  enabled: true,
  strict: true,
  maxLength: 4096,
  allowedCharacters: "",
  whitelistFields: [],
  trackEvents: true,
};

/**
 * Configuration for rate limiting (#1252).
 *
 * Limits are expressed as a maximum number of calls within a rolling window.
 */
export interface RateLimitConfig {
  /** Master switch for rate limiting. Defaults to `true`. */
  enabled?: boolean;
  /** Maximum calls allowed per window. Defaults to `100`. */
  maxRequests?: number;
  /** Window length in milliseconds. Defaults to `60000` (one minute). */
  windowMs?: number;
  /**
   * Per-user overrides keyed by user identifier. Each entry may specify its own
   * `maxRequests` and/or `windowMs`.
   */
  perUser?: Record<string, { maxRequests?: number; windowMs?: number }>;
  /** When `true`, rate-limit events are recorded. Defaults to `true`. */
  trackEvents?: boolean;
}

/** Resolved rate-limit configuration with all defaults applied. */
export interface ResolvedRateLimitConfig {
  enabled: boolean;
  maxRequests: number;
  windowMs: number;
  perUser: Record<string, { maxRequests: number; windowMs: number }>;
  trackEvents: boolean;
}

/** Default rate-limit configuration. */
export const DEFAULT_RATE_LIMIT_CONFIG: ResolvedRateLimitConfig = {
  enabled: true,
  maxRequests: 100,
  windowMs: 60_000,
  perUser: {},
  trackEvents: true,
};

/**
 * Configuration for CSRF protection (#1253).
 *
 * Applies to web integrations that exchange tokens between the browser and the
 * SDK.
 */
export interface CsrfConfig {
  /** Master switch for CSRF protection. Defaults to `true`. */
  enabled?: boolean;
  /** Token lifetime in milliseconds. Defaults to `3_600_000` (one hour). */
  tokenLifetimeMs?: number;
  /**
   * How long before expiry a token may be refreshed, in milliseconds.
   * Defaults to `300_000` (five minutes).
   */
  refreshWindowMs?: number;
  /** Header name used to transmit the token. Defaults to `x-csrf-token`. */
  headerName?: string;
  /** When `true`, CSRF events are recorded. Defaults to `true`. */
  trackEvents?: boolean;
}

/** Resolved CSRF configuration with all defaults applied. */
export interface ResolvedCsrfConfig {
  enabled: boolean;
  tokenLifetimeMs: number;
  refreshWindowMs: number;
  headerName: string;
  trackEvents: boolean;
}

/** Default CSRF configuration. */
export const DEFAULT_CSRF_CONFIG: ResolvedCsrfConfig = {
  enabled: true,
  tokenLifetimeMs: 3_600_000,
  refreshWindowMs: 300_000,
  headerName: "x-csrf-token",
  trackEvents: true,
};

/**
 * Configuration for secure key storage (#1254).
 *
 * The master secret is referenced by name rather than embedded so it can be
 * sourced from an environment variable or secret manager by the caller.
 */
export interface KeyStoreConfig {
  /** Master switch for secure key storage. Defaults to `true`. */
  enabled?: boolean;
  /**
   * Name of the environment variable (or secret-manager reference) holding the
   * master secret used to derive encryption keys. Never the secret itself.
   */
  masterSecretRef?: string;
  /** Key rotation interval in milliseconds. Defaults to `2_592_000_000` (30 days). */
  rotationIntervalMs?: number;
  /**
   * Identifiers permitted to access stored keys. When empty, all callers are
   * permitted (subject to other access controls).
   */
  allowedAccessors?: string[];
  /** When `true`, key usage events are recorded. Defaults to `true`. */
  trackEvents?: boolean;
}

/** Resolved key-store configuration with all defaults applied. */
export interface ResolvedKeyStoreConfig {
  enabled: boolean;
  masterSecretRef: string;
  rotationIntervalMs: number;
  allowedAccessors: string[];
  trackEvents: boolean;
}

/** Default key-store configuration. */
export const DEFAULT_KEY_STORE_CONFIG: ResolvedKeyStoreConfig = {
  enabled: true,
  masterSecretRef: "STELLARSPLIT_MASTER_SECRET",
  rotationIntervalMs: 2_592_000_000,
  allowedAccessors: [],
  trackEvents: true,
};

/** Aggregate security configuration for the SDK. */
export interface SecurityConfig {
  sanitization?: SanitizationConfig;
  rateLimit?: RateLimitConfig;
  csrf?: CsrfConfig;
  keyStore?: KeyStoreConfig;
}

/** Fully-resolved security configuration. */
export interface ResolvedSecurityConfig {
  sanitization: ResolvedSanitizationConfig;
  rateLimit: ResolvedRateLimitConfig;
  csrf: ResolvedCsrfConfig;
  keyStore: ResolvedKeyStoreConfig;
}

function resolveSanitizationConfig(
  config: SanitizationConfig = {},
): ResolvedSanitizationConfig {
  return {
    enabled: config.enabled ?? DEFAULT_SANITIZATION_CONFIG.enabled,
    strict: config.strict ?? DEFAULT_SANITIZATION_CONFIG.strict,
    maxLength: config.maxLength ?? DEFAULT_SANITIZATION_CONFIG.maxLength,
    allowedCharacters:
      config.allowedCharacters ?? DEFAULT_SANITIZATION_CONFIG.allowedCharacters,
    whitelistFields: [
      ...(config.whitelistFields ?? DEFAULT_SANITIZATION_CONFIG.whitelistFields),
    ],
    trackEvents: config.trackEvents ?? DEFAULT_SANITIZATION_CONFIG.trackEvents,
  };
}

function resolveRateLimitConfig(
  config: RateLimitConfig = {},
): ResolvedRateLimitConfig {
  const perUser: Record<string, { maxRequests: number; windowMs: number }> = {};
  const baseMax = config.maxRequests ?? DEFAULT_RATE_LIMIT_CONFIG.maxRequests;
  const baseWindow = config.windowMs ?? DEFAULT_RATE_LIMIT_CONFIG.windowMs;
  for (const [user, override] of Object.entries(config.perUser ?? {})) {
    perUser[user] = {
      maxRequests: override.maxRequests ?? baseMax,
      windowMs: override.windowMs ?? baseWindow,
    };
  }
  return {
    enabled: config.enabled ?? DEFAULT_RATE_LIMIT_CONFIG.enabled,
    maxRequests: baseMax,
    windowMs: baseWindow,
    perUser,
    trackEvents: config.trackEvents ?? DEFAULT_RATE_LIMIT_CONFIG.trackEvents,
  };
}

function resolveCsrfConfig(config: CsrfConfig = {}): ResolvedCsrfConfig {
  return {
    enabled: config.enabled ?? DEFAULT_CSRF_CONFIG.enabled,
    tokenLifetimeMs: config.tokenLifetimeMs ?? DEFAULT_CSRF_CONFIG.tokenLifetimeMs,
    refreshWindowMs: config.refreshWindowMs ?? DEFAULT_CSRF_CONFIG.refreshWindowMs,
    headerName: config.headerName ?? DEFAULT_CSRF_CONFIG.headerName,
    trackEvents: config.trackEvents ?? DEFAULT_CSRF_CONFIG.trackEvents,
  };
}

function resolveKeyStoreConfig(
  config: KeyStoreConfig = {},
): ResolvedKeyStoreConfig {
  return {
    enabled: config.enabled ?? DEFAULT_KEY_STORE_CONFIG.enabled,
    masterSecretRef:
      config.masterSecretRef ?? DEFAULT_KEY_STORE_CONFIG.masterSecretRef,
    rotationIntervalMs:
      config.rotationIntervalMs ?? DEFAULT_KEY_STORE_CONFIG.rotationIntervalMs,
    allowedAccessors: [
      ...(config.allowedAccessors ?? DEFAULT_KEY_STORE_CONFIG.allowedAccessors),
    ],
    trackEvents: config.trackEvents ?? DEFAULT_KEY_STORE_CONFIG.trackEvents,
  };
}

/**
 * Resolves a partial {@link SecurityConfig} into a fully-populated
 * {@link ResolvedSecurityConfig}, applying defaults for every omitted field.
 */
export function resolveSecurityConfig(
  config: SecurityConfig = {},
): ResolvedSecurityConfig {
  return {
    sanitization: resolveSanitizationConfig(config.sanitization),
    rateLimit: resolveRateLimitConfig(config.rateLimit),
    csrf: resolveCsrfConfig(config.csrf),
    keyStore: resolveKeyStoreConfig(config.keyStore),
  };
}

/** Default resolved security configuration. */
export const DEFAULT_SECURITY_CONFIG: ResolvedSecurityConfig =
  resolveSecurityConfig();