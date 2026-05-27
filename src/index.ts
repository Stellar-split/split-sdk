/**
 * @stellar-split/sdk — public API
 */

export { StellarSplitClient } from "./client.js";
export type { StellarSplitClientConfig, TxResult } from "./client.js";

export { TxQueue } from "./queue.js";

export { connectWallet, getPublicKey, signTransaction } from "./wallet.js";

export {
  formatAmount,
  parseAmount,
  isValidAddress,
  deadlineFromDays,
  isExpired,
  truncateAddress,
} from "./utils.js";

export type {
  Invoice,
  Payment,
  Recipient,
  InvoiceStatus,
  CreateInvoiceParams,
  PayParams,
} from "./types.js";
