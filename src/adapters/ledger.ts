import TransportWebHID from "@ledgerhq/hw-transport-webhid";
import type Transport from "@ledgerhq/hw-transport";
import Str from "@ledgerhq/hw-app-str";
import type { WalletAdapter } from "../types.js";

/**
 * Minimum Ledger device firmware version supported for signing Stellar
 * transactions. Older firmware lacks support for newer Stellar transaction
 * features (multi-operation submissions and the newer envelope extensions),
 * which makes signing fail silently.
 */
export const MIN_LEDGER_FIRMWARE = "2.0.0";

/**
 * Thrown before any signing attempt when the connected Ledger device runs a
 * firmware version older than {@link MIN_LEDGER_FIRMWARE}.
 */
export class LedgerFirmwareTooOldError extends Error {
  /** Firmware version reported by the device. */
  readonly actualVersion: string;
  /** Minimum firmware version required to sign. */
  readonly requiredVersion: string;

  constructor(actualVersion: string, requiredVersion: string = MIN_LEDGER_FIRMWARE) {
    super(
      `Ledger firmware ${actualVersion} is not supported. ` +
        `Update the device to firmware ${requiredVersion} or newer to sign Stellar transactions.`,
    );
    this.name = "LedgerFirmwareTooOldError";
    this.actualVersion = actualVersion;
    this.requiredVersion = requiredVersion;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Construction options for {@link LedgerAdapter}. */
export interface LedgerAdapterOptions {
  /**
   * When `true`, the pre-signing firmware version check is skipped entirely.
   * Intended for test environments (and for callers that have already verified
   * the device out-of-band). Defaults to `false`.
   */
  skipFirmwareCheck?: boolean;
  /**
   * Overrides how the device firmware version is read. Defaults to the
   * on-device `GET_VERSION` APDU sent over the transport.
   */
  getFirmwareVersion?: (transport: Transport) => Promise<string>;
  /**
   * Maximum number of idle transports kept in the pool. Defaults to `0`
   * (close the transport after every call); set to `1`+ to keep a device
   * connection open between calls.
   */
  maxPoolSize?: number;
  /**
   * Maximum age (ms) a pooled transport may be reused before it is recycled.
   * Defaults to 30 seconds.
   */
  maxIdleMs?: number;
}

/**
 * Parse a dotted version string into numeric segments.
 * Non-numeric segments (e.g. a `1.2.3-rc1` suffix) count as `0`.
 */
function parseVersionSegments(version: string): number[] {
  return version.split(".").map((segment) => {
    const parsed = Number.parseInt(segment, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  });
}

/**
 * Compare two dotted firmware version strings segment by segment.
 *
 * @returns A negative number when `a < b`, `0` when equal, positive when `a > b`.
 */
export function compareFirmwareVersions(a: string, b: string): number {
  const left = parseVersionSegments(a);
  const right = parseVersionSegments(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** A pooled transport together with the timestamp it was created at. */
interface PooledTransport {
  transport: Transport;
  createdAt: number;
}

/** Snapshot of pool counters exposed via {@link LedgerAdapter.getPoolStats}. */
export interface LedgerPoolStats {
  /** Transports currently idle in the pool. */
  idle: number;
  /** Transports currently checked out by callers. */
  inUse: number;
  /** Total transports created over the adapter lifetime. */
  created: number;
  /** Total transports recycled (closed) over the adapter lifetime. */
  recycled: number;
  /** Total failed health checks over the adapter lifetime. */
  healthCheckFailures: number;
}

/** Ledger hardware wallet adapter implementing WalletAdapter. */
export class LedgerAdapter implements WalletAdapter {
  /** Stable adapter identifier used for wallet detection and switching. */
  readonly name = "ledger";
  private readonly path: string;
  private readonly skipFirmwareCheck: boolean;
  private readonly getFirmwareVersion: (transport: Transport) => Promise<string>;
  private readonly maxPoolSize: number;
  private readonly maxIdleMs: number;
  private readonly pool: PooledTransport[] = [];
  private inUse = 0;
  private created = 0;
  private recycled = 0;
  private healthCheckFailures = 0;

  constructor(path = "44'/148'/0'", options: LedgerAdapterOptions = {}) {
    this.path = path;
    this.skipFirmwareCheck = options.skipFirmwareCheck ?? false;
    this.getFirmwareVersion =
      options.getFirmwareVersion ?? ((transport) => this.queryFirmwareVersion(transport));
    this.maxPoolSize = Math.max(0, options.maxPoolSize ?? 0);
    this.maxIdleMs = Math.max(0, options.maxIdleMs ?? 30_000);
  }

  /**
   * Whether the WebHID transport is usable in the current environment.
   * Ledger devices are only reachable when WebHID is exposed by the browser.
   */
  isAvailable(): boolean {
    try {
      const nav = (globalThis as { navigator?: { hid?: unknown } }).navigator;
      return typeof nav?.hid !== "undefined";
    } catch {
      return false;
    }
  }

  async getAddress(): Promise<string> {
    return this.withTransport(async (transport) => {
      const str = new Str(transport);
      const { publicKey } = await str.getPublicKey(this.path);
      return publicKey;
    });
  }

  /**
   * Open a transport session and return the device's Stellar public key.
   * Ledger has no separate "authorize" handshake distinct from reading the
   * public key, so this is equivalent to {@link getAddress}.
   */
  async connect(): Promise<string> {
    return this.getAddress();
  }

  /**
   * Ledger's WebHID transport has no push notification channel for account
   * switches (switching accounts means re-deriving a different `path`), so
   * there is nothing to subscribe to. Returns a no-op unsubscribe function.
   */
  onAccountChange(_handler: (address: string) => void): () => void {
    return () => {};
  }

  async signTransaction(xdr: string, _network: string): Promise<string> {
    return this.withTransport(async (transport) => {
      await this.assertFirmwareSupported(transport);
      const str = new Str(transport);
      const txBytes = Uint8Array.from(atob(xdr), (c) => c.charCodeAt(0));
      const { signature } = await str.signTransaction(
        this.path,
        txBytes as unknown as Buffer
      );
      const sigBytes = signature as unknown as Uint8Array;
      return btoa(String.fromCharCode(...sigBytes));
    });
  }

  /**
   * Close every idle transport in the pool. Transports currently checked out
   * are recycled by their owning call when it finishes.
   */
  async disconnect(): Promise<void> {
    while (this.pool.length > 0) {
      const pooled = this.pool.pop() as PooledTransport;
      await this.closeQuietly(pooled.transport);
      this.recycled += 1;
    }
  }

  /**
   * Current pool statistics. Useful for monitoring and diagnostics.
   */
  getPoolStats(): LedgerPoolStats {
    return {
      idle: this.pool.length,
      inUse: this.inUse,
      created: this.created,
      recycled: this.recycled,
      healthCheckFailures: this.healthCheckFailures,
    };
  }

  /**
   * Run `fn` against a pooled transport, recycling the transport afterwards.
   * On failure the transport is discarded (failover) so the next call opens a
   * fresh one instead of reusing a possibly broken connection.
   */
  private async withTransport<T>(fn: (transport: Transport) => Promise<T>): Promise<T> {
    const transport = await this.acquire();
    this.inUse += 1;
    try {
      const result = await fn(transport);
      await this.release(transport);
      return result;
    } catch (error) {
      await this.discard(transport);
      throw error;
    } finally {
      this.inUse -= 1;
    }
  }

  /**
   * Check out a transport from the pool. Reuses an idle transport when it is
   * still healthy and within its max idle age; otherwise opens a new one.
   */
  private async acquire(): Promise<Transport> {
    while (this.pool.length > 0) {
      const pooled = this.pool.pop() as PooledTransport;
      if (this.isRecyclable(pooled) && (await this.isHealthy(pooled.transport))) {
        return pooled.transport;
      }
      await this.closeQuietly(pooled.transport);
      this.recycled += 1;
    }
    const transport = await this.openTransport();
    this.created += 1;
    return transport;
  }

  /** Return a healthy transport to the pool, or recycle it when full/stale. */
  private async release(transport: Transport): Promise<void> {
    if (this.pool.length < this.maxPoolSize) {
      this.pool.push({ transport, createdAt: Date.now() });
      return;
    }
    await this.closeQuietly(transport);
    this.recycled += 1;
  }

  /** Discard a transport after a failure (failover). */
  private async discard(transport: Transport): Promise<void> {
    await this.closeQuietly(transport);
    this.recycled += 1;
  }

  /** A pooled transport is recyclable while it is younger than maxIdleMs. */
  private isRecyclable(pooled: PooledTransport): boolean {
    return Date.now() - pooled.createdAt < this.maxIdleMs;
  }

  /**
   * Lightweight health check: verify the transport still reports as open.
   * Transports that fail the check are counted and treated as unhealthy.
   */
  private async isHealthy(transport: Transport): Promise<boolean> {
    try {
      const candidate = transport as unknown as { isOpen?: boolean };
      if (typeof candidate.isOpen === "boolean" && !candidate.isOpen) {
        this.healthCheckFailures += 1;
        return false;
      }
      return true;
    } catch {
      this.healthCheckFailures += 1;
      return false;
    }
  }

  private async closeQuietly(transport: Transport): Promise<void> {
    try {
      await transport.close();
    } catch {
      // Ignore close errors while recycling.
    }
  }

  /**
   * Reject with {@link LedgerFirmwareTooOldError} when the device firmware is
   * older than {@link MIN_LEDGER_FIRMWARE}. No-op when the check is skipped.
   */
  private async assertFirmwareSupported(transport: Transport): Promise<void> {
    if (this.skipFirmwareCheck) return;
    const version = await this.getFirmwareVersion(transport);
    if (compareFirmwareVersions(version, MIN_LEDGER_FIRMWARE) < 0) {
      throw new LedgerFirmwareTooOldError(version);
    }
  }

  /**
   * Query the device firmware version using the BOLOS `GET_VERSION` APDU
   * (`CLA 0xE0`, `INS 0x01`). The transport strips the status word, leaving a
   * payload whose trailing three bytes are `major.minor.patch` (some devices
   * prefix a format/target byte, so the last three bytes are used).
   */
  private async queryFirmwareVersion(transport: Transport): Promise<string> {
    const response = await transport.send(0xe0, 0x01, 0x00, 0x00);
    const bytes = Array.from(response as unknown as Uint8Array);
    const versionBytes = bytes.length > 3 ? bytes.slice(-3) : bytes;
    if (versionBytes.length < 3) {
      throw new Error(
        `Unexpected firmware version response from Ledger device (${bytes.length} byte(s)).`,
      );
    }
    return versionBytes.join(".");
  }

  private async openTransport(): Promise<Transport> {
    try {
      return await TransportWebHID.create();
    } catch {
      throw new Error(
        "Ledger device not connected. Please connect your Ledger and open the Stellar app."
      );
    }
  }
}
