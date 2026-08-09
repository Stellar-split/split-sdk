/**
 * Detects Soroban network protocol upgrades and exposes typed feature flags.
 *
 * Queries `SorobanRpc.Server.getNetwork()` for the current protocol version
 * and `getLedgerEntries()` for the `ConfigSettingContractComputeV0` entry to
 * read resource limits. Results are cached and re-detected after a
 * configurable staleness interval so the SDK never re-probes on every call.
 */

import { rpc as SorobanRpc, xdr } from "@stellar/stellar-sdk";
import { TypedEventEmitter } from "./events/TypedEventEmitter.js";
import type { SorobanFeatureFlags } from "./types.js";

/** Protocol version at which ExtendFootprintTtl / RestoreFootprint became available. */
const STATE_ARCHIVAL_PROTOCOL_VERSION = 20;

/** Protocol version at which SetTrustLineFlags replaced the legacy AllowTrust operation. */
const SET_TRUST_LINE_FLAGS_PROTOCOL_VERSION = 18;

/** Events emitted by {@link SorobanFeatureDetector}. */
export interface SorobanFeatureDetectorEventMap {
  [key: string]: unknown;
  protocolUpgradeDetected: { previousVersion: number; newVersion: number };
}

/** Configuration for {@link SorobanFeatureDetector}. */
export interface SorobanFeatureDetectorConfig {
  /** Soroban RPC endpoint URL. */
  rpcUrl: string;
  /** Milliseconds before cached flags are considered stale. Default: 1 hour. */
  staleAfterMs?: number;
}

const DEFAULT_STALE_AFTER_MS = 60 * 60 * 1000;

const FALLBACK_FLAGS: Omit<SorobanFeatureFlags, "detectedAt"> = {
  protocolVersion: 0,
  supportsExtendFootprint: false,
  supportsRestoreFootprint: false,
  maxInstructionsPerTx: 0,
  maxInstructionsPerLedger: 0,
};

/**
 * Detects the current Soroban protocol version and derives typed feature
 * flags from it, caching the result and emitting `protocolUpgradeDetected`
 * when a re-check observes a version change.
 */
// ---------------------------------------------------------------------------
// Standalone helpers used by TrustlineAuthHandler
// ---------------------------------------------------------------------------

/**
 * Query the Horizon server's root resource to obtain the current protocol version.
 *
 * @param server - Horizon server instance (must expose a `root()` method).
 */
export async function detectProtocolVersion(
  server: { root: () => Promise<{ current_protocol_version: number }> },
): Promise<number> {
  const root = await server.root();
  return root.current_protocol_version;
}

/**
 * Returns `true` when the given protocol version supports `SetTrustLineFlags`
 * (protocol >= 18). Older networks must use the legacy `AllowTrust` operation.
 */
export function supportsSetTrustLineFlags(protocolVersion: number): boolean {
  return protocolVersion >= SET_TRUST_LINE_FLAGS_PROTOCOL_VERSION;
}

export class SorobanFeatureDetector extends TypedEventEmitter<SorobanFeatureDetectorEventMap> {
  private readonly server: SorobanRpc.Server;
  private readonly staleAfterMs: number;
  private cached: SorobanFeatureFlags | null = null;

  constructor(config: SorobanFeatureDetectorConfig) {
    super();
    this.server = new SorobanRpc.Server(config.rpcUrl, {
      allowHttp: config.rpcUrl.startsWith("http://"),
    });
    this.staleAfterMs = config.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  }

  /**
   * Return the current feature flags, using the cached value unless it is
   * stale (older than `staleAfterMs`).
   */
  async detect(): Promise<SorobanFeatureFlags> {
    if (this.cached && Date.now() - this.cached.detectedAt < this.staleAfterMs) {
      return this.cached;
    }

    const previousVersion = this.cached?.protocolVersion;
    const flags = await this.probe();

    if (previousVersion !== undefined && previousVersion !== flags.protocolVersion) {
      this.emit("protocolUpgradeDetected", {
        previousVersion,
        newVersion: flags.protocolVersion,
      });
    }

    this.cached = flags;
    return flags;
  }

  /** Force a re-detection on the next {@link detect} call. */
  invalidate(): void {
    this.cached = null;
  }

  private async probe(): Promise<SorobanFeatureFlags> {
    const network = await this.server.getNetwork();
    const protocolVersion = parseInt(String(network.protocolVersion), 10) || 0;

    let maxInstructionsPerTx = FALLBACK_FLAGS.maxInstructionsPerTx;
    let maxInstructionsPerLedger = FALLBACK_FLAGS.maxInstructionsPerLedger;

    try {
      const key = xdr.LedgerKey.configSetting(
        new xdr.LedgerKeyConfigSetting({
          configSettingId: xdr.ConfigSettingId.configSettingContractComputeV0(),
        }),
      );
      const response = await this.server.getLedgerEntries(key);
      const entry = response.entries[0];
      const computeV0 = entry?.val.configSetting().contractCompute();
      if (computeV0) {
        maxInstructionsPerTx = Number(computeV0.txMaxInstructions());
        maxInstructionsPerLedger = Number(computeV0.ledgerMaxInstructions());
      }
    } catch {
      // Resource limits unavailable — fall back to defaults, protocol version is still valid.
    }

    return {
      protocolVersion,
      supportsExtendFootprint: protocolVersion >= STATE_ARCHIVAL_PROTOCOL_VERSION,
      supportsRestoreFootprint: protocolVersion >= STATE_ARCHIVAL_PROTOCOL_VERSION,
      maxInstructionsPerTx,
      maxInstructionsPerLedger,
      detectedAt: Date.now(),
    };
  }
}
