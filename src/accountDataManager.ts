/**
 * Typed CRUD manager for Stellar account data entries.
 *
 * Wraps `Operation.manageData()` with validation for the protocol's 64-byte
 * key/value limits and 64-entry-per-account cap, so callers can store custom
 * metadata alongside SDK state without hand-rolling raw manageData calls.
 */

import {
  Account,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import type { AccountDataMap } from "./types.js";
import { DataEntryValidationError } from "./errors.js";

/** Stellar protocol limit for both data entry keys and values, in bytes. */
const MAX_DATA_ENTRY_BYTES = 64;

/** Stellar protocol limit on the number of data entries per account. */
const MAX_DATA_ENTRIES = 64;

/** Result of submitting a manageData transaction. */
export interface TransactionResult {
  txHash: string;
}

/** Configuration for {@link AccountDataManager}. */
export interface AccountDataManagerConfig {
  /** Horizon server URL. */
  horizonUrl: string;
  /** Stellar network passphrase. */
  networkPassphrase: string;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Typed CRUD manager for account data entries, built on top of
 * `Operation.manageData()` and `Server.loadAccount().data_attr`.
 */
export class AccountDataManager {
  private readonly server: Horizon.Server;
  private readonly networkPassphrase: string;

  constructor(config: AccountDataManagerConfig) {
    this.server = new Horizon.Server(config.horizonUrl);
    this.networkPassphrase = config.networkPassphrase;
  }

  /**
   * Set (create or update) a data entry on `accountId`.
   *
   * @throws DataEntryValidationError if the key/value exceed 64 bytes, or if
   *         the account already has 64 entries and `key` is new.
   */
  async set(
    accountId: string,
    key: string,
    value: string,
    signerSecret: string,
  ): Promise<TransactionResult> {
    await this.validateEntry(accountId, key, value);
    return this.submitManageData(accountId, key, value, signerSecret);
  }

  /**
   * Fetch the current value of `key` on `accountId`, or `null` if absent.
   */
  async get(accountId: string, key: string): Promise<string | null> {
    const entries = await this.list(accountId);
    return Object.prototype.hasOwnProperty.call(entries, key) ? entries[key]! : null;
  }

  /**
   * Delete a data entry by submitting `manageData` with a `null` value.
   */
  async delete(
    accountId: string,
    key: string,
    signerSecret: string,
  ): Promise<TransactionResult> {
    return this.submitManageData(accountId, key, null, signerSecret);
  }

  /**
   * Return all data entries currently stored on `accountId`, decoded from
   * base64 to UTF-8 strings.
   */
  async list(accountId: string): Promise<AccountDataMap> {
    const account = await this.server.loadAccount(accountId);
    const raw = account.data_attr as Record<string, string> | undefined;
    const result: AccountDataMap = {};
    for (const [key, base64Value] of Object.entries(raw ?? {})) {
      result[key] = Buffer.from(base64Value, "base64").toString("utf8");
    }
    return result;
  }

  private async validateEntry(accountId: string, key: string, value: string): Promise<void> {
    if (byteLength(key) > MAX_DATA_ENTRY_BYTES) {
      throw new DataEntryValidationError(
        `key "${key}" exceeds ${MAX_DATA_ENTRY_BYTES} bytes`,
        { key },
      );
    }
    if (byteLength(value) > MAX_DATA_ENTRY_BYTES) {
      throw new DataEntryValidationError(
        `value for key "${key}" exceeds ${MAX_DATA_ENTRY_BYTES} bytes`,
        { key },
      );
    }

    const existing = await this.list(accountId);
    const isNewKey = !Object.prototype.hasOwnProperty.call(existing, key);
    if (isNewKey && Object.keys(existing).length >= MAX_DATA_ENTRIES) {
      throw new DataEntryValidationError(
        `account ${accountId} already has ${MAX_DATA_ENTRIES} data entries`,
        { accountId },
      );
    }
  }

  private async submitManageData(
    accountId: string,
    key: string,
    value: string | null,
    signerSecret: string,
  ): Promise<TransactionResult> {
    const keypair = Keypair.fromSecret(signerSecret);
    const loaded = await this.server.loadAccount(accountId);
    const sourceAccount = new Account(loaded.accountId(), loaded.sequenceNumber());

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(Operation.manageData({ name: key, value: value ?? null }))
      .setTimeout(30)
      .build();

    tx.sign(keypair);
    const result = await this.server.submitTransaction(tx);
    return { txHash: result.hash };
  }
}
