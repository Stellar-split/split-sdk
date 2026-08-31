import type { Signer } from "../signer.js";
import { TypedEventEmitter } from "../../events/TypedEventEmitter.js";

/**
 * Options for signing with {@link KmsClient}.
 */
export interface KmsClientSignOptions {
  /**
   * Target cloud KMS region for this signing request.
   */
  region?: string;
}

/**
 * Minimal client contract for a cloud KMS (AWS KMS, GCP Cloud KMS, Azure Key
 * Vault, HashiCorp Vault, ...). Implementations are intentionally left to the
 * caller so the SDK carries no vendor SDK dependency and tests can mock the
 * client without touching real KMS credentials.
 */
export interface KmsClient {
  /**
   * Sign `digest` (typically a 32-byte transaction hash) with the key
   * identified by `keyId`, returning the raw signature bytes.
   */
  sign(keyId: string, digest: Buffer, options?: KmsClientSignOptions): Promise<Buffer>;
}

/**
 * Options for configuring {@link CloudKmsSigner}.
 */
export interface CloudKmsSignerOptions {
  /**
   * Primary Cloud KMS region.
   */
  region?: string;

  /**
   * Fallback Cloud KMS regions to attempt in order if a region-specific error
   * (e.g., HTTP 503, timeout, connection failure) occurs in the primary region.
   */
  fallbackRegions?: string[];
}

/**
 * Events emitted by {@link CloudKmsSigner}.
 */
export interface CloudKmsSignerEventMap {
  regionFallback: { from: string; to: string };
}

/**
 * Returns true if an error is indicative of a region-specific or transient
 * availability failure (e.g. 503 Service Unavailable, timeout, network error)
 * rather than a permanent non-region error (e.g. 403 Forbidden, 401 Unauthorized,
 * 400 Validation, 404 KeyNotFound).
 */
export function isRegionError(err: unknown): boolean {
  if (!err) return false;

  if (typeof err === "object") {
    const errorObj = err as Record<string, unknown>;

    if (typeof errorObj.isRegionError === "boolean") {
      return errorObj.isRegionError;
    }

    const status = (errorObj.statusCode ?? errorObj.status ?? errorObj.code) as number | string | undefined;

    // Non-region HTTP status codes
    if (
      status === 400 ||
      status === 401 ||
      status === 403 ||
      status === 404 ||
      status === 422 ||
      status === "400" ||
      status === "401" ||
      status === "403" ||
      status === "404" ||
      status === "422"
    ) {
      return false;
    }

    // Region-specific HTTP status codes
    if (
      status === 408 ||
      status === 429 ||
      status === 500 ||
      status === 502 ||
      status === 503 ||
      status === 504 ||
      status === "408" ||
      status === "429" ||
      status === "500" ||
      status === "502" ||
      status === "503" ||
      status === "504"
    ) {
      return true;
    }

    // Known node network / timeout error codes
    const code = typeof errorObj.code === "string" ? errorObj.code.toUpperCase() : "";
    if (
      code === "ETIMEDOUT" ||
      code === "ECONNRESET" ||
      code === "ECONNREFUSED" ||
      code === "EHOSTUNREACH" ||
      code === "ENOTFOUND" ||
      code === "EAI_AGAIN" ||
      code === "UND_ERR_CONNECT_TIMEOUT" ||
      code === "UND_ERR_SOCKET"
    ) {
      return true;
    }

    const name = typeof errorObj.name === "string" ? errorObj.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return true;
    }
  }

  // Inspect error message string
  const message = err instanceof Error ? err.message : String(err);
  const lowerMsg = message.toLowerCase();

  // Explicit non-region error keywords
  const nonRegionKeywords = [
    "accessdenied",
    "access denied",
    "permissiondenied",
    "permission denied",
    "unauthorized",
    "forbidden",
    "invalidkey",
    "invalid key",
    "keynotfound",
    "key not found",
    "notfoundexception",
    "validationexception",
    "invalidparameter",
    "invalid parameter",
    "invalidargument",
    "invalid argument",
    "unrecognizedclientexception",
  ];

  for (const keyword of nonRegionKeywords) {
    if (lowerMsg.includes(keyword)) {
      return false;
    }
  }

  // Region-specific / transient error keywords
  const regionKeywords = [
    "503",
    "502",
    "504",
    "408",
    "429",
    "service unavailable",
    "serviceunavailable",
    "unavailable",
    "timeout",
    "timed out",
    "gateway timeout",
    "bad gateway",
    "connection refused",
    "connection reset",
    "network error",
    "econnreset",
    "econnrefused",
    "etimedout",
    "enotfound",
    "ehostunreach",
    "region unavailable",
    "endpoint unreachable",
    "rate limit",
    "throttled",
    "throttling",
    "kms unavailable",
    "internal server error",
  ];

  for (const keyword of regionKeywords) {
    if (lowerMsg.includes(keyword)) {
      return true;
    }
  }

  return false;
}

/**
 * {@link Signer} that delegates signing to an injected {@link KmsClient}.
 *
 * Supports multi-region fallback: when configured with fallback regions,
 * transient or region-specific errors (503, timeouts, network disconnects)
 * will cause the signer to sequentially attempt signing in each fallback region
 * in order, emitting a `regionFallback` event on each switch.
 *
 * @example
 * ```ts
 * const signer = new CloudKmsSigner(awsKmsClient, "alias/split-signing-key", {
 *   region: "us-east-1",
 *   fallbackRegions: ["us-west-2", "eu-central-1"],
 * });
 * signer.on("regionFallback", ({ from, to }) => {
 *   console.warn(`Cloud KMS region failed (${from}), falling back to ${to}`);
 * });
 * const signature = await signer.sign(txHash);
 * ```
 */
export class CloudKmsSigner extends TypedEventEmitter<CloudKmsSignerEventMap> implements Signer {
  readonly kmsClient: KmsClient;
  readonly keyId: string;
  readonly region?: string;
  readonly fallbackRegions: string[];

  constructor(kmsClient: KmsClient, keyId: string, options?: CloudKmsSignerOptions) {
    super();
    this.kmsClient = kmsClient;
    this.keyId = keyId;
    this.region = options?.region;
    this.fallbackRegions = options?.fallbackRegions ? [...options.fallbackRegions] : [];
  }

  async sign(txHash: Buffer): Promise<Buffer> {
    const regions: string[] = [
      ...(this.region ? [this.region] : []),
      ...this.fallbackRegions,
    ];

    if (regions.length === 0) {
      return this.kmsClient.sign(this.keyId, txHash);
    }

    let lastError: unknown;

    for (let i = 0; i < regions.length; i++) {
      const currentRegion = regions[i];
      try {
        return await this.kmsClient.sign(this.keyId, txHash, { region: currentRegion });
      } catch (error) {
        lastError = error;

        const hasNextRegion = i + 1 < regions.length;
        if (hasNextRegion && isRegionError(error)) {
          const nextRegion = regions[i + 1];
          this.emit("regionFallback", { from: currentRegion, to: nextRegion });
          continue;
        }

        throw error;
      }
    }

    throw lastError;
  }
}

