/**
 * @stellar-split/sdk — public API
 */

export { StellarSplitClient } from "./client.js";
export type { StellarSplitClientConfig, NetworkConfig, TxResult } from "./client.js";

export { TxQueue } from "./queue.js";

export { exportInvoice } from "./export.js";

export { replayEvents } from "./events.js";

export { connectWallet, getPublicKey, signTransaction } from "./wallet.js";

export { checkRPCHealth } from "./health.js";

export { getOptimisticInvoice } from "./optimistic.js";

export { watchContractUpgrade } from "./upgrade.js";

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
  PaginatedResult,
  PaginationOptions,
} from "./types.js";

export { LedgerAdapter } from "./adapters/ledger.js";
