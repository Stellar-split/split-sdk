import { BaseClientModule } from "./BaseModule.js";
import type {
  Invoice,
  CreateInvoiceParams,
  SimulationResult,
  InvoiceStatus,
  InvoiceFilter,
  InvoicePage,
  InvoiceSnapshot,
} from "../../types.js";
import type { PerMethodRetryOptions } from "../../retryPolicy.js";
import { withTrace } from "../../tracing.js";

/**
 * Module dedicated to Invoice lifecycle operations: creation, querying,
 * updates, cloning, snapshots, and verification.
 *
 * Each top-level public method runs inside its own trace scope so that all
 * telemetry and logger output produced during the call share a single trace ID.
 * Nested internal calls inherit the parent's trace ID.
 */
export class InvoiceModule extends BaseClientModule {
  /**
   * Creates a new invoice on-chain, or simulates creation when `simulate: true`.
   */
  async create<TMetadata = Record<string, unknown>>(
    params: CreateInvoiceParams<TMetadata> & { simulate: true }
  ): Promise<SimulationResult>;
  async create<TMetadata = Record<string, unknown>>(
    params: CreateInvoiceParams<TMetadata>
  ): Promise<{ invoiceId: string; txHash: string }>;
  async create<TMetadata = Record<string, unknown>>(
    params: CreateInvoiceParams<TMetadata>
  ): Promise<{ invoiceId: string; txHash: string } | SimulationResult> {
    return withTrace("InvoiceModule.create", () =>
      this.client.createInvoice(params as any)
    );
  }

  /** Alias for `create`. */
  async createInvoice<TMetadata = Record<string, unknown>>(
    params: CreateInvoiceParams<TMetadata> & { simulate: true }
  ): Promise<SimulationResult>;
  async createInvoice<TMetadata = Record<string, unknown>>(
    params: CreateInvoiceParams<TMetadata>
  ): Promise<{ invoiceId: string; txHash: string }>;
  async createInvoice<TMetadata = Record<string, unknown>>(
    params: CreateInvoiceParams<TMetadata>
  ): Promise<{ invoiceId: string; txHash: string } | SimulationResult> {
    return withTrace("InvoiceModule.createInvoice", () =>
      this.create(params as any)
    );
  }

  /**
   * Retrieves an invoice by ID.
   */
  async get<TMetadata = Record<string, unknown>, TStatus extends InvoiceStatus = InvoiceStatus>(
    invoiceId: string,
    opts?: { retry?: PerMethodRetryOptions; dedupe?: boolean; traceId?: string; timeout?: number }
  ): Promise<Invoice<TMetadata, TStatus>> {
    return withTrace("InvoiceModule.get", () =>
      this.client.getInvoice(invoiceId, opts) as Promise<Invoice<TMetadata, TStatus>>
    );
  }

  /** Alias for `get`. */
  async getInvoice<TMetadata = Record<string, unknown>, TStatus extends InvoiceStatus = InvoiceStatus>(
    invoiceId: string,
    opts?: { retry?: PerMethodRetryOptions; dedupe?: boolean; traceId?: string; timeout?: number }
  ): Promise<Invoice<TMetadata, TStatus>> {
    return withTrace("InvoiceModule.getInvoice", () => this.get(invoiceId, opts));
  }

  /**
   * Clones an existing invoice with optional parameter overrides.
   */
  async clone(
    invoiceId: string,
    overrides?: Partial<CreateInvoiceParams>
  ): Promise<string> {
    return withTrace("InvoiceModule.clone", () =>
      this.client.cloneInvoice(invoiceId, overrides)
    );
  }

  /** Alias for `clone`. */
  async cloneInvoice(
    invoiceId: string,
    overrides?: Partial<CreateInvoiceParams>
  ): Promise<string> {
    return withTrace("InvoiceModule.cloneInvoice", () =>
      this.clone(invoiceId, overrides)
    );
  }

  /**
   * Updates an invoice with the provided changes.
   */
  async update(invoiceId: string, updates: Partial<Invoice>): Promise<Invoice> {
    return withTrace("InvoiceModule.update", () =>
      this.client.updateInvoice(invoiceId, updates)
    );
  }

  /** Alias for `update`. */
  async updateInvoice(invoiceId: string, updates: Partial<Invoice>): Promise<Invoice> {
    return withTrace("InvoiceModule.updateInvoice", () =>
      this.update(invoiceId, updates)
    );
  }

  /**
   * Updates the lifecycle status of an invoice.
   */
  async updateStatus(invoiceId: string, to: InvoiceStatus): Promise<Invoice> {
    return withTrace("InvoiceModule.updateStatus", () =>
      this.client.updateInvoiceStatus(invoiceId, to)
    );
  }

  /** Alias for `updateStatus`. */
  async updateInvoiceStatus(invoiceId: string, to: InvoiceStatus): Promise<Invoice> {
    return withTrace("InvoiceModule.updateInvoiceStatus", () =>
      this.updateStatus(invoiceId, to)
    );
  }

  /**
   * Queries invoices with filtering options.
   */
  async query<TMetadata = Record<string, unknown>>(filter: InvoiceFilter = {}): Promise<InvoicePage> {
    return withTrace("InvoiceModule.query", () => this.client.queryInvoices(filter));
  }

  /** Alias for `query`. */
  async queryInvoices<TMetadata = Record<string, unknown>>(filter: InvoiceFilter = {}): Promise<InvoicePage> {
    return withTrace("InvoiceModule.queryInvoices", () => this.query(filter));
  }

  /**
   * Cancels an invoice.
   */
  async cancel(invoiceId: string) {
    return withTrace("InvoiceModule.cancel", () => this.client.cancel(invoiceId));
  }

  /**
   * Finalizes an invoice on-chain.
   */
  async finalize(invoiceId: string, caller?: string) {
    return withTrace("InvoiceModule.finalize", () =>
      this.client.finalizeInvoice(invoiceId, caller)
    );
  }

  /** Alias for `finalize`. */
  async finalizeInvoice(invoiceId: string, caller?: string) {
    return withTrace("InvoiceModule.finalizeInvoice", () =>
      this.finalize(invoiceId, caller)
    );
  }

  /**
   * Synchronizes an invoice's on-chain state with optimistic tracking.
   */
  async sync(invoiceId: string, options?: { traceId?: string; timeout?: number }) {
    return withTrace("InvoiceModule.sync", () =>
      this.client.syncInvoice(invoiceId, options)
    );
  }

  /** Alias for `sync`. */
  async syncInvoice(invoiceId: string, options?: { traceId?: string; timeout?: number }) {
    return withTrace("InvoiceModule.syncInvoice", () =>
      this.sync(invoiceId, options)
    );
  }

  /**
   * Takes a point-in-time snapshot of an invoice.
   */
  async snapshot(invoiceId: string): Promise<InvoiceSnapshot> {
    return withTrace("InvoiceModule.snapshot", () =>
      this.client.snapshotInvoice(invoiceId)
    );
  }

  /** Alias for `snapshot`. */
  async snapshotInvoice(invoiceId: string): Promise<InvoiceSnapshot> {
    return withTrace("InvoiceModule.snapshotInvoice", () =>
      this.snapshot(invoiceId)
    );
  }

  /**
   * Verifies the cryptographic hash of an invoice.
   */
  async verify(invoice: Invoice, expectedHash: string): Promise<boolean> {
    return withTrace("InvoiceModule.verify", () =>
      this.client.verifyInvoice(invoice, expectedHash)
    );
  }

  /** Alias for `verify`. */
  async verifyInvoice(invoice: Invoice, expectedHash: string): Promise<boolean> {
    return withTrace("InvoiceModule.verifyInvoice", () =>
      this.verify(invoice, expectedHash)
    );
  }

  /**
   * Fetches invoices created by a specific creator address.
   */
  async getByCreator(
    creator: string,
    opts?: { limit?: number; cursor?: string }
  ): Promise<Invoice[]> {
    return withTrace("InvoiceModule.getByCreator", () =>
      this.client.getInvoicesByCreator(creator, opts)
    );
  }

  /** Alias for `getByCreator`. */
  async getInvoicesByCreator(
    creator: string,
    opts?: { limit?: number; cursor?: string }
  ): Promise<Invoice[]> {
    return withTrace("InvoiceModule.getInvoicesByCreator", () =>
      this.getByCreator(creator, opts)
    );
  }

  /**
   * Fetches invoices where the specified address is a recipient.
   */
  async getByRecipient(
    recipient: string,
    opts?: { limit?: number; cursor?: string }
  ): Promise<Invoice[]> {
    return withTrace("InvoiceModule.getByRecipient", () =>
      this.client.getInvoicesByRecipient(recipient, opts)
    );
  }

  /** Alias for `getByRecipient`. */
  async getInvoicesByRecipient(
    recipient: string,
    opts?: { limit?: number; cursor?: string }
  ): Promise<Invoice[]> {
    return withTrace("InvoiceModule.getInvoicesByRecipient", () =>
      this.getByRecipient(recipient, opts)
    );
  }

  /**
   * Resolves the full ancestor/descendant clone chain for an invoice.
   */
  async resolveCloneChain(invoiceId: string): Promise<Invoice[]> {
    return withTrace("InvoiceModule.resolveCloneChain", () =>
      this.client.resolveCloneChain(invoiceId)
    );
  }

  /**
   * Retrieves the lineage IDs for a cloned invoice.
   */
  async getLineage(invoiceId: string | bigint): Promise<bigint[]> {
    return withTrace("InvoiceModule.getLineage", () =>
      this.client.getLineage(invoiceId)
    );
  }
}
