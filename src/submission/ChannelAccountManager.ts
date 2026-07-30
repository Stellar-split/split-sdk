/**
 * ChannelAccountManager (#485)
 *
 * Maintains a pool of pre-funded Stellar channel accounts and assigns one to
 * each outgoing transaction so that multiple transactions can be submitted in
 * parallel without being serialised on a single source account's sequence
 * number.
 *
 * Usage:
 * ```ts
 * const manager = new ChannelAccountManager({
 *   accounts: [
 *     { publicKey: "GABC...", secretKey: "SABC..." },
 *     { publicKey: "GDEF...", secretKey: "SDEF..." },
 *   ],
 *   acquireTimeoutMs: 5_000,
 *   horizonUrl: "https://horizon-testnet.stellar.org",
 * });
 *
 * const assignment = await manager.acquire();
 * try {
 *   // build + submit the transaction using assignment.account as fee-bump source
 * } finally {
 *   assignment.release();
 * }
 * ```
 */

import { Horizon } from "@stellar/stellar-sdk";
import { ChannelExhaustedError } from "../errors.js";
import type {
  ChannelAccount,
  ChannelAssignment,
  ChannelPoolConfig,
} from "../types/channels.js";

// ---------------------------------------------------------------------------
// Internal state per slot
// ---------------------------------------------------------------------------

interface PoolSlot {
  account: ChannelAccount;
  inUse: boolean;
  lowBalance: boolean;
}

// ---------------------------------------------------------------------------
// ChannelAccountManager
// ---------------------------------------------------------------------------

/**
 * Thread-safe (single-process) pool of Stellar channel accounts.
 *
 * @see ChannelPoolConfig
 */
export class ChannelAccountManager {
  private readonly _slots: PoolSlot[];
  private readonly _config: Required<ChannelPoolConfig>;
  private readonly _server: Horizon.Server;

  /**
   * Pending `acquire()` waiters: each entry is a resolve callback that will
   * be called with the next available slot once one is released.
   */
  private readonly _waiters: Array<(slot: PoolSlot) => void> = [];

  constructor(config: ChannelPoolConfig) {
    if (config.accounts.length === 0) {
      throw new Error("ChannelAccountManager requires at least one account.");
    }

    this._config = {
      accounts: config.accounts,
      minBalanceXlm: config.minBalanceXlm ?? 1,
      refillThreshold: config.refillThreshold ?? 2,
      acquireTimeoutMs: config.acquireTimeoutMs ?? 10_000,
      horizonUrl: config.horizonUrl ?? "https://horizon.stellar.org",
    };

    this._server = new Horizon.Server(this._config.horizonUrl);

    this._slots = config.accounts.map((account) => ({
      account,
      inUse: false,
      lowBalance: false,
    }));
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Acquire an available channel account.
   *
   * - If one is immediately available it is returned synchronously (wrapped
   *   in a resolved Promise).
   * - If all channels are currently in use the call queues and resolves when
   *   one is released.
   * - If `acquireTimeoutMs > 0` and no channel becomes available within that
   *   window, a `ChannelExhaustedError` is thrown.
   *
   * The returned `ChannelAssignment.release()` **must** be called after the
   * transaction settles (success or failure).
   */
  async acquire(): Promise<ChannelAssignment> {
    // Refresh balances to exclude low-balance accounts
    await this._refreshBalances();

    const slot = this._findAvailableSlot();

    if (slot) {
      return this._assignSlot(slot);
    }

    // All slots in use — queue
    return this._waitForSlot();
  }

  /**
   * Returns a snapshot of channel accounts whose XLM balance is below
   * `minBalanceXlm`.  The accounts are still in the pool so callers can
   * decide to top them up.
   */
  getLowBalanceAccounts(): ChannelAccount[] {
    return this._slots
      .filter((s) => s.lowBalance)
      .map((s) => s.account);
  }

  /**
   * Returns the total number of channel accounts in the pool.
   */
  get poolSize(): number {
    return this._slots.length;
  }

  /**
   * Returns the number of channel accounts currently in use.
   */
  get inUseCount(): number {
    return this._slots.filter((s) => s.inUse).length;
  }

  /**
   * Returns the number of channel accounts currently available for assignment.
   */
  get availableCount(): number {
    return this._slots.filter((s) => !s.inUse && !s.lowBalance).length;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private _findAvailableSlot(): PoolSlot | undefined {
    return this._slots.find((s) => !s.inUse && !s.lowBalance);
  }

  private async _assignSlot(slot: PoolSlot): Promise<ChannelAssignment> {
    slot.inUse = true;

    // Fetch the latest sequence number fresh from Horizon
    let sequenceNumber = "0";
    try {
      const acct = await this._server.loadAccount(slot.account.publicKey);
      sequenceNumber = acct.sequenceNumber();
    } catch {
      // Non-fatal: caller will handle submission errors themselves
      sequenceNumber = "0";
    }

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      slot.inUse = false;
      this._notifyWaiters();
    };

    return {
      account: slot.account,
      sequenceNumber,
      release,
    };
  }

  private _waitForSlot(): Promise<ChannelAssignment> {
    const { acquireTimeoutMs } = this._config;
    const poolSize = this._slots.length;

    return new Promise<ChannelAssignment>((resolve, reject) => {
      let settled = false;

      const waiter = (slot: PoolSlot) => {
        if (settled) return;
        settled = true;
        resolve(this._assignSlot(slot));
      };

      this._waiters.push(waiter);

      if (acquireTimeoutMs > 0) {
        setTimeout(() => {
          if (settled) return;
          settled = true;
          // Remove this waiter from the queue
          const idx = this._waiters.indexOf(waiter);
          if (idx !== -1) this._waiters.splice(idx, 1);
          reject(new ChannelExhaustedError(poolSize, acquireTimeoutMs));
        }, acquireTimeoutMs);
      }
    });
  }

  private _notifyWaiters(): void {
    if (this._waiters.length === 0) return;
    const slot = this._findAvailableSlot();
    if (!slot) return;

    const waiter = this._waiters.shift();
    if (waiter) waiter(slot);
  }

  /**
   * Fetch XLM balances for all slots and mark those below `minBalanceXlm`.
   * Errors per-account are silently swallowed so one bad account doesn't
   * block the whole pool from being refreshed.
   */
  private async _refreshBalances(): Promise<void> {
    const { minBalanceXlm } = this._config;

    await Promise.allSettled(
      this._slots.map(async (slot) => {
        try {
          const acct = await this._server.loadAccount(slot.account.publicKey);
          const native = acct.balances.find(
            (b) => b.asset_type === "native",
          );
          if (native) {
            const xlm = parseFloat(native.balance);
            slot.lowBalance = xlm < minBalanceXlm;
          }
        } catch {
          // Keep the previous lowBalance state on error
        }
      }),
    );
  }
}
