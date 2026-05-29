/**
 * @stellar-split/sdk — public API
 */

export { StellarSplitClient } from "./client.js";
export type { StellarSplitClientConfig, NetworkConfig, TxResult } from "./client.js";

export { Deduplicator } from "./dedup.js";

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

export { registerWebhook, triggerWebhook } from "./webhook.js";
export type { WebhookConfig, WebhookEvent } from "./webhook.js";

export type { WalletAdapter } from "./adapters/types.js";
export { WalletConnectAdapter } from "./adapters/walletconnect.js";
export { LedgerAdapter } from "./adapters/ledger.js";

export { subscribeToInvoice } from "./stream.js";

export { validateTransition } from "./stateMachineValidator.js";

export {
  addRequestInterceptor,
  addResponseInterceptor,
} from "./interceptors.js";
export type { RequestInterceptor, ResponseInterceptor, RPCRequest, RPCResponse } from "./interceptors.js";

export { diffInvoice } from "./diff.js";

export { getSDKHealth, resetSDKHealth } from "./healthDashboard.js";

export { subscribeToInvoice } from "./stream.js";

export {
  StellarSplitError,
  InvoiceNotFoundError,
  InvoiceNotPendingError,
  DeadlinePassedError,
  PaymentExceedsRemainingError,
  InvoiceFrozenError,
  parseSorobanError,
} from "./errors.js";

export { SimpleCache } from "./cache.js";

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
  BatchPayment,
  InvoiceEventCallbacks,
  SimulateCreateInvoiceResult,
  SimulatePayResult,
  InvoiceDiff,
  SDKHealth,
  BatchPayment,
  InvoiceEventCallbacks,
  SimulateCreateInvoiceResult,
  SimulatePayResult,
  FeeEstimate,
} from "./types.js";
export { InvalidTransitionError } from "./types.js";

