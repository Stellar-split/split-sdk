import { StellarSplitClient } from "./client.js";
import type { StellarSplitClientConfig, TxResult } from "./client.js";
import type { CreateInvoiceParams, PayParams } from "./types.js";

/** Extended client type that includes deprecated shim methods. */
export type CompatClient = StellarSplitClient & {
  createBill(params: CreateInvoiceParams): Promise<{ invoiceId: string; txHash: string }>;
  sendPayment(params: PayParams): Promise<TxResult>;
};

/**
 * Create a backwards-compatible StellarSplitClient with deprecated method shims.
 * Each deprecated call logs a console.warn with migration guidance.
 *
 * @param config - Standard StellarSplitClientConfig.
 * @returns Client instance with deprecated methods attached.
 */
export function createCompatClient(config: StellarSplitClientConfig): CompatClient {
  const client = new StellarSplitClient(config) as CompatClient;

  client.createBill = async (params: CreateInvoiceParams) => {
    console.warn(
      "[StellarSplitSDK] createBill is deprecated and will be removed in a future release. " +
        "Use createInvoice instead."
    );
    return client.createInvoice(params);
  };

  client.sendPayment = async (params: PayParams) => {
    console.warn(
      "[StellarSplitSDK] sendPayment is deprecated and will be removed in a future release. " +
        "Use pay instead."
    );
    return client.pay(params);
  };

  return client;
}
