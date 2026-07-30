/**
 * Types for the ChannelAccountManager (#485).
 */

/** A single channel account entry in the pool. */
export interface ChannelAccount {
  /** Stellar G… public key of the channel account. */
  publicKey: string;
  /** Ed25519 secret key of the channel account (used to sign as fee-bump source). */
  secretKey: string;
}

/**
 * Configuration for the channel account pool.
 */
export interface ChannelPoolConfig {
  /** List of channel accounts available in the pool. */
  accounts: ChannelAccount[];
  /**
   * Minimum XLM balance required for an account to remain eligible.
   * Accounts below this threshold are excluded from the pool and reported
   * by `getLowBalanceAccounts()`.
   * @default 1
   */
  minBalanceXlm?: number;
  /**
   * XLM balance threshold at which an account should be refilled.
   * Used as a soft warning; does not exclude the account.
   * @default 2
   */
  refillThreshold?: number;
  /**
   * Milliseconds to wait for a channel account to become available before
   * throwing `ChannelExhaustedError`. Pass `0` or omit to block indefinitely.
   * @default 10_000
   */
  acquireTimeoutMs?: number;
  /**
   * Horizon API base URL used to fetch fresh sequence numbers and balances.
   * @default "https://horizon.stellar.org"
   */
  horizonUrl?: string;
}

/**
 * Represents a channel account that has been assigned for a specific
 * outgoing transaction.  Call `release()` after the transaction settles.
 */
export interface ChannelAssignment {
  /** The assigned channel account. */
  account: ChannelAccount;
  /** Current sequence number fetched fresh from Horizon at acquire time. */
  sequenceNumber: string;
  /**
   * Release this channel account back to the pool so other callers can use it.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  release(): void;
}
