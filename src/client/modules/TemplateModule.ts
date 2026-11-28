import { BaseClientModule } from "./BaseModule.js";
import type { TxResult } from "../../client.js";
import type { Invoice, InvoiceTemplate } from "../../types.js";

/**
 * Module dedicated to Invoice Templates and Recurring Invoice operations.
 */
export class TemplateModule extends BaseClientModule {
  /**
   * Saves an invoice template.
   */
  async save(creator: string, template: InvoiceTemplate): Promise<TxResult> {
    return this.client.saveTemplate(creator, template);
  }

  /** Alias for `save`. */
  async saveTemplate(creator: string, template: InvoiceTemplate): Promise<TxResult> {
    return this.save(creator, template);
  }

  /**
   * Creates a new invoice from a saved template.
   */
  async createFromTemplate(
    creator: string,
    templateName: string,
    deadline: number
  ): Promise<{ invoiceId: string; txHash: string }> {
    return this.client.createFromTemplate(creator, templateName, deadline);
  }

  /**
   * Lists all templates saved by a creator address.
   */
  async list(creator: string): Promise<string[]> {
    return this.client.listTemplates(creator);
  }

  /** Alias for `list`. */
  async listTemplates(creator: string): Promise<string[]> {
    return this.list(creator);
  }

  /**
   * Retrieves recurring invoices created by an address.
   */
  async getRecurring(creator: string): Promise<Invoice[]> {
    return this.client.getRecurringInvoices(creator);
  }

  /** Alias for `getRecurring`. */
  async getRecurringInvoices(creator: string): Promise<Invoice[]> {
    return this.getRecurring(creator);
  }

  /**
   * Cancels a recurring invoice.
   */
  async cancelRecurring(invoiceId: string, creator: string): Promise<TxResult> {
    return this.client.cancelRecurring(invoiceId, creator);
  }

  /**
   * Updates the recurring amount on an invoice.
   */
  async updateRecurringAmount(
    invoiceId: string,
    creator: string,
    newAmounts: bigint[]
  ): Promise<TxResult> {
    return this.client.updateRecurringAmount(invoiceId, creator, newAmounts);
  }
}
