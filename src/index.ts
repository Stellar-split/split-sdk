/**
 * @stellar-split/sdk — public API
 */

export { StellarSplitClient } from "./client.js";
export type { StellarSplitClientConfig, TxResult } from "./client.js";

export { connectWallet, getPublicKey, signTransaction } from "./wallet.js";

export {
  formatAmount,
  parseAmount,
  isValidAddress,
  deadlineFromDays,
  isExpired,
  truncateAddress,
} from "./utils.js";

export { pollUSDCBalance, initPoller } from "./poller.js";

export { telemetry } from "./telemetry.js";

export type { WalletAdapter } from "./adapters/types.js";
export { WalletConnectAdapter } from "./adapters/walletconnect.js";

export type {
  Invoice,
  Payment,
  Recipient,
  InvoiceStatus,
  CreateInvoiceParams,
  PayParams,
  InvoiceTemplate,
  ApprovalResult,
  InvoiceAnalytics,
} from "./types.js";
