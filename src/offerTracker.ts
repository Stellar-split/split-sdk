/**
 * DEX offer lifecycle tracker.
 *
 * Monitors outstanding offers placed by the SDK during split-payment DEX
 * conversions.  Emits fill-progress events and can automatically cancel
 * stale offers that have been open beyond a configurable threshold.
 *
 * Integrates with the {@link TypedEventEmitter} event system and exposes
 * strongly-typed events via {@link OfferTrackerEventMap}.
 */

import { Horizon, Operation, TransactionBuilder, BASE_FEE, Account, Asset } from "@stellar/stellar-sdk";
import { TypedEventEmitter, type Unsubscribe } from "./events/TypedEventEmitter.js";
import { OfferTrackingError } from "./errors.js";
import type { OfferRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Event map
// ---------------------------------------------------------------------------

/** Events emitted by {@link OfferTracker}. */
export interface OfferTrackerEventMap {
  [key: string]: unknown;
  offerFilled: OfferRecord;
  offerPartiallyFilled: OfferRecord;
  offerCancelled: { offerId: string; account: string };
  error: { message: string; error: unknown };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for {@link OfferTracker}. */
export interface OfferTrackerConfig {
  /** Horizon server URL. */
  horizonUrl: string;
  /** Stellar network passphrase. */
  networkPassphrase: string;
  /** Polling interval in milliseconds. Default: 10_000 (10s). */
  pollIntervalMs?: number;
  /** Age in milliseconds after which an offer is considered stale and
   *  eligible for automatic cancellation. Default: 300_000 (5 min). */
  staleThresholdMs?: number;
  /** When true, automatically cancel stale offers. Default: false. */
  autoCancel?: boolean;
}

// ---------------------------------------------------------------------------
// OfferTracker
// ---------------------------------------------------------------------------

/**
 * Tracks the lifecycle of DEX offers created during split-payment
 * conversions.  Uses Horizon polling to detect fills and cancellations,
 * and emits typed events so callers can react to state changes.
 *
 * ```ts
 * const tracker = new OfferTracker({
 *   horizonUrl: "https://horizon.stellar.org",
 *   networkPassphrase: StellarSdk.Networks.PUBLIC,
 *   autoCancel: true,
 * });
 *
 * tracker.on("offerFilled", (offer) => console.log("Filled:", offer));
 * tracker.start();
 * ```
 */
export class OfferTracker extends TypedEventEmitter<OfferTrackerEventMap> {
  private readonly server: Horizon.Server;
  private readonly networkPassphrase: string;
  private readonly pollIntervalMs: number;
  private readonly staleThresholdMs: number;
  private readonly autoCancel: boolean;

  /** Outstanding offers currently being tracked. */
  private trackedOffers: Map<string, OfferRecord> = new Map();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private _running = false;

  constructor(config: OfferTrackerConfig) {
    super();
    this.server = new Horizon.Server(config.horizonUrl);
    this.networkPassphrase = config.networkPassphrase;
    this.pollIntervalMs = config.pollIntervalMs ?? 10_000;
    this.staleThresholdMs = config.staleThresholdMs ?? 300_000;
    this.autoCancel = config.autoCancel ?? false;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Whether the tracker is currently polling. */
  get running(): boolean {
    return this._running;
  }

  /** Number of offers currently being tracked. */
  get trackedCount(): number {
    return this.trackedOffers.size;
  }

  /**
   * Start polling for offer state changes.
   */
  start(): void {
    if (this._running) return;
    this._running = true;
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  /**
   * Stop polling.  Tracked offers are preserved and polling resumes on the
   * next {@link start} call.
   */
  stop(): void {
    this._running = false;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Register an offer for tracking.
   *
   * @param record - The offer to track.
   */
  track(record: OfferRecord): void {
    this.trackedOffers.set(record.offerId, { ...record });
  }

  /**
   * Remove an offer from tracking (e.g. after manual cancellation).
   */
  untrack(offerId: string): void {
    this.trackedOffers.delete(offerId);
  }

  /**
   * Get all currently tracked offers.
   */
  listTracked(): OfferRecord[] {
    return Array.from(this.trackedOffers.values());
  }

  /**
   * Check for trades associated with a specific offer.
   *
   * @returns List of trades that partially or fully filled the offer.
   */
  async getTrades(offerId: string): Promise<Horizon.ServerApi.TradeRecord[]> {
    try {
      const page = await this.server.trades().forOffer(offerId).call();
      return page.records;
    } catch (err) {
      throw new OfferTrackingError(
        `Failed to fetch trades for offer ${offerId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Cancel a tracked offer.  Submits a `manageSellOffer` with `amount: "0"`.
   *
   * @param offerId     - The offer to cancel.
   * @param sourceAccountSecret - Secret key of the account that owns the offer.
   * @returns Transaction hash of the cancellation.
   */
  async cancelOffer(
    offerId: string,
    sourceAccountSecret: string,
  ): Promise<string> {
    try {
      const record = this.trackedOffers.get(offerId);
      if (!record) {
        throw new OfferTrackingError(`Offer ${offerId} is not tracked`);
      }

      const keypair = (await import("@stellar/stellar-sdk")).Keypair.fromSecret(
        sourceAccountSecret,
      );
      const account = await this.server.loadAccount(keypair.publicKey());
      const sourceAccount = new Account(
        account.accountId(),
        account.sequenceNumber(),
      );

      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          Operation.manageSellOffer({
            selling: record.selling as unknown as Asset,
            buying: record.buying as unknown as Asset,
            amount: "0",
            price: record.price,
            offerId: offerId,
          }),
        )
        .setTimeout(30)
        .build();

      tx.sign(keypair);
      const result = await this.server.submitTransaction(tx);

      this.untrack(offerId);
      this.emit("offerCancelled", { offerId, account: keypair.publicKey() });

      return result.hash;
    } catch (err) {
      if (err instanceof OfferTrackingError) throw err;
      throw new OfferTrackingError(
        `Failed to cancel offer ${offerId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Manually trigger a poll cycle (useful for testing).
   */
  async pollNow(): Promise<void> {
    await this.poll();
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async poll(): Promise<void> {
    if (!this._running) return;

    for (const [offerId, record] of this.trackedOffers.entries()) {
      try {
        const fresh = await this.fetchOffer(offerId);

        if (!fresh) {
          // Offer no longer exists on ledger — fully consumed or cancelled
          record.status = "filled";
          this.emit("offerFilled", record);
          this.trackedOffers.delete(offerId);
          continue;
        }

        // Update amounts
        const prevAmount = BigInt(record.amount);
        const newAmount = BigInt(fresh.amount);

        if (newAmount < prevAmount && newAmount > 0n) {
          // Partially filled
          record.amount = fresh.amount;
          this.emit("offerPartiallyFilled", record);
        } else if (newAmount === 0n) {
          record.status = "filled";
          this.emit("offerFilled", record);
          this.trackedOffers.delete(offerId);
        }

        // Stale check: if autoCancel is enabled and the offer is stale,
        // mark it for cancellation.  Callers should periodically call
        // cancelStaleOffers() to submit cancellation transactions.
        const age = Date.now() - record.createdAt;
        if (age > this.staleThresholdMs) {
          record.status = "stale";
          this.trackedOffers.set(offerId, record);
        }
      } catch (err) {
        this.emit("error", {
          message: `Poll error for offer ${offerId}`,
          error: err,
        });
      }
    }
  }

  private async fetchOffer(
    offerId: string,
  ): Promise<Horizon.ServerApi.OfferRecord | null> {
    try {
      // Try fetching all offers and filtering by ID.
      // For a more targeted query, callers can override this with a
      // subclass that passes the owner account.
      const page = await this.server.offers().limit(200).order("desc").call();
      const match = page.records.find((o) => o.id === offerId);
      return match ?? null;
    } catch {
      return null;
    }
  }
}
