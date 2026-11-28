import type { Keypair } from "@stellar/stellar-sdk";
import { BaseClientModule } from "./BaseModule.js";
import type { TxResult } from "../../client.js";
import type {
  AdminFreezeResult,
  AdminUnfreezeResult,
  QueueActionParams,
  TimelockAction,
} from "../../types.js";

/**
 * Module dedicated to Administrative operations:
 * invoice freeze/unfreeze and timelock actions.
 */
export class AdminModule extends BaseClientModule {
  /**
   * Freezes an invoice administratively.
   */
  async freeze(invoiceId: string, admin?: string): Promise<TxResult> {
    return this.client.adminFreeze(invoiceId, admin as string);
  }

  /** Alias for `freeze`. */
  async adminFreeze(invoiceId: string, admin: string): Promise<TxResult> {
    return this.freeze(invoiceId, admin);
  }

  /**
   * Freezes an invoice with a recorded reason.
   */
  async freezeInvoice(
    invoiceId: string,
    reason: string,
    adminKeypair: Keypair
  ): Promise<AdminFreezeResult> {
    return this.client.adminFreezeInvoice(invoiceId, reason, adminKeypair);
  }

  /** Alias for `freezeInvoice`. */
  async adminFreezeInvoice(
    invoiceId: string,
    reason: string,
    adminKeypair: Keypair
  ): Promise<AdminFreezeResult> {
    return this.freezeInvoice(invoiceId, reason, adminKeypair);
  }

  /**
   * Unfreezes an invoice administratively.
   */
  async unfreeze(invoiceId: string, admin?: string): Promise<TxResult> {
    return this.client.adminUnfreeze(invoiceId, admin as string);
  }

  /** Alias for `unfreeze`. */
  async adminUnfreeze(invoiceId: string, admin: string): Promise<TxResult> {
    return this.unfreeze(invoiceId, admin);
  }

  /**
   * Unfreezes an invoice administratively.
   */
  async unfreezeInvoice(invoiceId: string, adminKeypair: Keypair): Promise<AdminUnfreezeResult> {
    return this.client.adminUnfreezeInvoice(invoiceId, adminKeypair);
  }

  /** Alias for `unfreezeInvoice`. */
  async adminUnfreezeInvoice(invoiceId: string, adminKeypair: Keypair): Promise<AdminUnfreezeResult> {
    return this.unfreezeInvoice(invoiceId, adminKeypair);
  }

  /**
   * Queues a timelock administrative action.
   */
  async queueAction(params: QueueActionParams): Promise<{ actionId: string; txHash: string }> {
    return this.client.queueAction(params);
  }

  /**
   * Executes a previously queued timelock action whose delay has elapsed.
   */
  async executeAction(caller: string, actionId: string): Promise<TxResult> {
    return this.client.executeAction(caller, actionId);
  }

  /**
   * Cancels a queued timelock action.
   */
  async cancelAction(caller: string, actionId: string): Promise<TxResult> {
    return this.client.cancelAction(caller, actionId);
  }

  /**
   * Retrieves the current status of a timelock action.
   */
  async getActionStatus(actionId: string): Promise<TimelockAction> {
    return this.client.getActionStatus(actionId);
  }
}
