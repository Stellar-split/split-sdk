import { BaseClientModule } from "./BaseModule.js";
import type { TxResult } from "../../client.js";
import type {
  InvoiceGroup,
  GroupStats,
} from "../../types.js";

/**
 * Module dedicated to Invoice Grouping operations:
 * creating groups, attaching invoices, release, and group statistics.
 */
export class GroupModule extends BaseClientModule {
  /**
   * Creates a new invoice group. Forwards all arguments as given to
   * `client.createGroup`, which supports several positional overloads.
   */
  async create(...args: unknown[]): Promise<unknown> {
    return (this.client.createGroup as (...a: unknown[]) => Promise<unknown>)(...args);
  }

  /** Alias for `create`. */
  async createGroup(...args: unknown[]): Promise<unknown> {
    return this.create(...args);
  }

  /**
   * Adds an invoice to an existing group.
   */
  async addInvoice(creator: string, groupId: string, invoiceId: string): Promise<TxResult> {
    return this.client.addInvoiceToGroup(creator, groupId, invoiceId);
  }

  /** Alias for `addInvoice`. */
  async addInvoiceToGroup(creator: string, groupId: string, invoiceId: string): Promise<TxResult> {
    return this.addInvoice(creator, groupId, invoiceId);
  }

  /**
   * Gets the details and status of an invoice group.
   */
  async getStatus(groupId: string): Promise<InvoiceGroup> {
    return this.client.getGroupStatus(groupId);
  }

  /** Alias for `getStatus`. */
  async getGroupStatus(groupId: string): Promise<InvoiceGroup> {
    return this.getStatus(groupId);
  }

  /**
   * Releases all funds held within a group of invoices.
   */
  async release(
    creatorOrGroupId: string,
    groupIdOrOptions?: string | { caller: string }
  ): Promise<TxResult> {
    return this.client.releaseGroup(creatorOrGroupId as any, groupIdOrOptions as any);
  }

  /** Alias for `release`. */
  async releaseGroup(
    creatorOrGroupId: string,
    groupIdOrOptions?: string | { caller: string }
  ): Promise<TxResult> {
    return this.release(creatorOrGroupId, groupIdOrOptions);
  }

  /**
   * Retrieves aggregated statistics for an invoice group.
   */
  async getStats(groupId: string): Promise<GroupStats> {
    return this.client.getGroupStats(groupId);
  }

  /** Alias for `getStats`. */
  async getGroupStats(groupId: string): Promise<GroupStats> {
    return this.getStats(groupId);
  }

  /**
   * Gets the list of invoice IDs belonging to a group.
   */
  async getInvoices(groupId: string): Promise<bigint[]> {
    return this.client.getGroupInvoices(groupId);
  }

  /** Alias for `getInvoices`. */
  async getGroupInvoices(groupId: string): Promise<bigint[]> {
    return this.getInvoices(groupId);
  }
}
