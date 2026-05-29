/**
 * StellarSplitClient — TypeScript client for the StellarSplit Soroban contract.
 *
 * Wraps @stellar/stellar-sdk contract invocation with typed methods.
 */

import {
  Address,
  Contract,
  rpc as SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { signTransaction } from "./wallet.js";
import { telemetry } from "./telemetry.js";
import { checkRPCHealth } from "./health.js";
import { Deduplicator } from "./dedup.js";
import { initHealthDashboard, recordCall } from "./healthDashboard.js";
import {
  runRequestInterceptors,
  runResponseInterceptors,
} from "./interceptors.js";
import { InvoiceNotFoundError } from "./types.js";
import type {
  ApprovalResult,
  BatchPayment,
  ArbiterVote,
  CreateInvoiceParams,
  DisputeResult,
  Invoice,
  InvoiceGroup,
  InvoiceEventCallbacks,
  InvoiceStatus,
  PaginatedResult,
  PaginationOptions,
  Payment,
  PayParams,
  Recipient,
  InvoiceTemplate,
  RPCHealth,
  SimulateCreateInvoiceResult,
  SimulatePayResult,
  WalletAdapter,
} from "./types.js";
import { subscribeToInvoice as _subscribeToInvoice } from "./stream.js";

/** A plugin that extends StellarSplitClient with new methods at runtime. */
export interface StellarSplitPlugin {
  /** Unique plugin name — duplicate registrations throw. */
  name: string;
  /** Called with the client instance; attach new methods here. */
  install(client: StellarSplitClient): void;
}

/** Configuration for StellarSplitClient. */
export interface StellarSplitClientConfig {
  /** Soroban RPC endpoint URL. */
  rpcUrl: string;
  /** Stellar network passphrase. */
  networkPassphrase: string;
  /** Deployed StellarSplit contract ID. */
  contractId: string;
  /** Optional telemetry configuration. */
  telemetry?: {
    endpoint: string;
    optOut?: boolean;
  };
  /** Fee multiplier applied when a transaction is stuck (default: 2). */
  feeBumpMultiplier?: number;
  /** Optional wallet adapter for signing (e.g. WalletConnect). Defaults to Freighter. */
  adapter?: WalletAdapter;
}

/** Network configuration. */
export interface NetworkConfig {
  /** Soroban RPC endpoint URL. */
  rpcUrl: string;
  /** Stellar network passphrase. */
  networkPassphrase: string;
  /** Deployed StellarSplit contract ID. */
  contractId: string;
}

/** Result of a transaction submission. */
export interface TxResult {
  txHash: string;
}

/** Built-in network presets. */
const NETWORKS: Record<string, NetworkConfig> = {
  testnet: {
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "",
  },
  mainnet: {
    rpcUrl: "https://soroban-mainnet.stellar.org",
    networkPassphrase: "Public Global Stellar Network ; September 2015",
    contractId: "",
  },
};

export class StellarSplitClient {
  private server: SorobanRpc.Server;
  private contract: Contract;
  private config: StellarSplitClientConfig;
  private _plugins = new Set<string>();
  private _dedup = new Deduplicator<Invoice>();

  constructor(config: StellarSplitClientConfig) {
    this.config = config;
    this.server = new SorobanRpc.Server(config.rpcUrl, {
      allowHttp: config.rpcUrl.startsWith("http://"),
    });
    this.contract = new Contract(config.contractId);

    if (config.telemetry) {
      telemetry.init(config.telemetry);
    }

    initHealthDashboard(this.server, this._dedup);
  }

  // ---------------------------------------------------------------------------
  // Plugin system
  // ---------------------------------------------------------------------------

  /**
   * Register a plugin that extends this client instance.
   * Throws if a plugin with the same name has already been registered.
   */
  registerPlugin(plugin: StellarSplitPlugin): void {
    if (this._plugins.has(plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" is already registered.`);
    }
    this._plugins.add(plugin.name);
    plugin.install(this);
  }

  // ---------------------------------------------------------------------------
  // Dispute management
  // ---------------------------------------------------------------------------

  /**
   * Dispute an invoice by ID.
   * @param invoiceId - The ID of the invoice to dispute.
   * @returns The dispute ID and transaction hash.
   */
  async disputeInvoice(invoiceId: string): Promise<DisputeResult> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "dispute_invoice",
        nativeToScVal(BigInt(invoiceId), { type: "u64" })
      );
      // Assuming the creator is the one calling dispute
      // You may want to pass the creator as a parameter if needed
      const result = await this._submitTx(this.config.contractId, operation);
      const disputeId = scValToNative(result.returnValue).toString();
      telemetry.recordMethod("disputeInvoice", true, Date.now() - startTime);
      return { disputeId, txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod("disputeInvoice", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Submit an arbiter's vote for a dispute.
   * @param vote - The arbiter vote parameters.
   * @returns The dispute ID and transaction hash.
   */
  async submitArbiterVote(vote: ArbiterVote): Promise<DisputeResult> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "submit_arbiter_vote",
        nativeToScVal(BigInt(vote.invoiceId), { type: "u64" }),
        nativeToScVal(vote.arbiter, { type: "address" }),
        nativeToScVal(vote.approve, { type: "bool" })
      );
      const result = await this._submitTx(vote.arbiter, operation);
      const disputeId = scValToNative(result.returnValue).toString();
      telemetry.recordMethod("submitArbiterVote", true, Date.now() - startTime);
      return { disputeId, txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod("submitArbiterVote", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Resolve a dispute for an invoice.
   * @param invoiceId - The ID of the invoice to resolve dispute for.
   * @returns The dispute ID and transaction hash.
   */
  async resolveDispute(invoiceId: string): Promise<DisputeResult> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "resolve_dispute",
        nativeToScVal(BigInt(invoiceId), { type: "u64" })
      );
      const result = await this._submitTx(this.config.contractId, operation);
      const disputeId = scValToNative(result.returnValue).toString();
      telemetry.recordMethod("resolveDispute", true, Date.now() - startTime);
      return { disputeId, txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod("resolveDispute", false, Date.now() - startTime);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Create a new on-chain invoice.
   *
   * @returns The new invoice ID and the transaction hash.
   */
  async createInvoice(
    params: CreateInvoiceParams
  ): Promise<{ invoiceId: string; txHash: string }> {
    const startTime = Date.now();
    try {
      const recipientAddresses = params.recipients.map((r) =>
        nativeToScVal(r.address, { type: "address" })
      );
      const recipientAmounts = params.recipients.map((r) =>
        nativeToScVal(r.amount, { type: "i128" })
      );

      const operation = this.contract.call(
        "create_invoice",
        nativeToScVal(params.creator, { type: "address" }),
        xdr.ScVal.scvVec(recipientAddresses),
        xdr.ScVal.scvVec(recipientAmounts),
        nativeToScVal(params.token, { type: "address" }),
        nativeToScVal(params.deadline, { type: "u64" })
      );

      const result = await this._submitTx(params.creator, operation);
      const invoiceId = scValToNative(result.returnValue).toString();
      telemetry.recordMethod("createInvoice", true, Date.now() - startTime);
      return { invoiceId, txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod("createInvoice", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Clone an existing invoice with a new deadline.
   *
   * @param sourceId    - ID of the invoice to clone.
   * @param creator     - Address of the creator (must sign).
   * @param newDeadline - Unix timestamp for the new invoice's deadline.
   * @returns The new invoice ID and transaction hash.
   * @throws {InvoiceNotFoundError} If the source invoice does not exist.
   */
  async cloneInvoice(
    sourceId: string,
    creator: string,
    newDeadline: number
  ): Promise<{ invoiceId: string; txHash: string }> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "clone_invoice",
        nativeToScVal(BigInt(sourceId), { type: "u64" }),
        nativeToScVal(newDeadline, { type: "u64" })
      );

      const result = await this._submitTx(creator, operation);
      const invoiceId = scValToNative(result.returnValue).toString();
      telemetry.recordMethod("cloneInvoice", true, Date.now() - startTime);
      return { invoiceId, txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod("cloneInvoice", false, Date.now() - startTime);
      if (error instanceof Error && error.message.includes("not found")) {
        throw new InvoiceNotFoundError(sourceId);
      }
      throw error;
    }
  }

  /**
   * Pay toward an invoice.
   *
   * @returns The transaction hash.
   */
  async pay(params: PayParams): Promise<TxResult> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "pay",
        nativeToScVal(params.payer, { type: "address" }),
        nativeToScVal(BigInt(params.invoiceId), { type: "u64" }),
        nativeToScVal(params.amount, { type: "i128" })
      );

      const result = await this._submitTx(params.payer, operation);
      telemetry.recordMethod("pay", true, Date.now() - startTime);
      return { txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod("pay", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Create multiple invoices in a single transaction.
   *
   * @param params - Array of invoice creation parameters (1-5 items)
   * @returns All created invoice IDs and the transaction hash
   */
  async batchCreateInvoices(
    params: CreateInvoiceParams[]
  ): Promise<{ invoiceIds: string[]; txHash: string }> {
    if (params.length === 0 || params.length > 5) {
      throw new Error("Batch size must be between 1 and 5 items");
    }

    const invoiceParams = params.map((p) => {
      const recipientAddresses = p.recipients.map((r) =>
        nativeToScVal(r.address, { type: "address" })
      );
      const recipientAmounts = p.recipients.map((r) =>
        nativeToScVal(r.amount, { type: "i128" })
      );

      const mapEntries: xdr.ScMapEntry[] = [
        new xdr.ScMapEntry({
          key: nativeToScVal("creator", { type: "symbol" }) as xdr.ScVal,
          val: nativeToScVal(p.creator, { type: "address" }) as xdr.ScVal,
        }),
        new xdr.ScMapEntry({
          key: nativeToScVal("recipients", { type: "symbol" }) as xdr.ScVal,
          val: xdr.ScVal.scvVec(recipientAddresses),
        }),
        new xdr.ScMapEntry({
          key: nativeToScVal("amounts", { type: "symbol" }) as xdr.ScVal,
          val: xdr.ScVal.scvVec(recipientAmounts),
        }),
        new xdr.ScMapEntry({
          key: nativeToScVal("token", { type: "symbol" }) as xdr.ScVal,
          val: nativeToScVal(p.token, { type: "address" }) as xdr.ScVal,
        }),
        new xdr.ScMapEntry({
          key: nativeToScVal("deadline", { type: "symbol" }) as xdr.ScVal,
          val: nativeToScVal(p.deadline, { type: "u64" }) as xdr.ScVal,
        }),
      ];

      return xdr.ScVal.scvMap(mapEntries);
    });

    const operation = this.contract.call(
      "create_batch",
      xdr.ScVal.scvVec(invoiceParams)
    );

    const result = await this._submitTx(params[0].creator, operation);
    const invoiceIds = (scValToNative(result.returnValue) as (string | number)[]).map(
      (id) => id.toString()
    );
    return { invoiceIds, txHash: result.txHash };
  }

  /**
   * Fetch an invoice by ID.
   */
  async getInvoice(invoiceId: string): Promise<Invoice> {
    return this._dedup.dedupe(invoiceId, () => this._fetchInvoice(invoiceId));
  }

  private async _fetchInvoice(invoiceId: string): Promise<Invoice> {
    const startTime = Date.now();
    const req = { method: "getInvoice", params: [invoiceId] };
    await runRequestInterceptors(req);
    try {
      const operation = this.contract.call(
        "get_invoice",
        nativeToScVal(BigInt(invoiceId), { type: "u64" })
      );

      const account = await this.server.getAccount(this.config.contractId).catch(() => null);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sourceAccount = account ?? ({ accountId: () => this.config.contractId, sequenceNumber: () => "0", incrementSequenceNumber: () => {} } as any);

      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      const simResult = await this.server.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(simResult)) {
        throw new Error(`Simulation failed: ${simResult.error}`);
      }

      const returnVal = (simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
      if (!returnVal) throw new Error("No return value from get_invoice");

      const invoice = this._parseInvoice(invoiceId, scValToNative(returnVal));
      telemetry.recordMethod("getInvoice", true, Date.now() - startTime);
      const durationMs = Date.now() - startTime;
      await runResponseInterceptors({ method: "getInvoice", result: invoice, durationMs });
      recordCall(true);
      return invoice;
    } catch (error) {
      telemetry.recordMethod("getInvoice", false, Date.now() - startTime);
      const durationMs = Date.now() - startTime;
      await runResponseInterceptors({ method: "getInvoice", result: undefined, durationMs });
      recordCall(false);
      throw error;
    }
  }

  /**
   * Fetch all payments for an invoice.
   */
  async getPayments(invoiceId: string): Promise<Payment[]> {
    const startTime = Date.now();
    try {
      const invoice = await this.getInvoice(invoiceId);
      telemetry.recordMethod("getPayments", true, Date.now() - startTime);
      return invoice.payments;
    } catch (error) {
      telemetry.recordMethod("getPayments", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Save an invoice template for reuse.
   *
   * @returns The transaction hash.
   */
  async saveTemplate(
    creator: string,
    template: InvoiceTemplate
  ): Promise<TxResult> {
    const startTime = Date.now();
    try {
      const recipientAddresses = template.recipients.map((r) =>
        nativeToScVal(r.address, { type: "address" })
      );
      const recipientAmounts = template.recipients.map((r) =>
        nativeToScVal(r.amount, { type: "i128" })
      );

      const operation = this.contract.call(
        "save_template",
        nativeToScVal(creator, { type: "address" }),
        nativeToScVal(template.name, { type: "string" }),
        xdr.ScVal.scvVec(recipientAddresses),
        xdr.ScVal.scvVec(recipientAmounts),
        nativeToScVal(template.token, { type: "address" })
      );

      const result = await this._submitTx(creator, operation);
      telemetry.recordMethod("saveTemplate", true, Date.now() - startTime);
      return { txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod("saveTemplate", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Create an invoice from a saved template.
   *
   * @returns The new invoice ID and the transaction hash.
   */
  async createFromTemplate(
    creator: string,
    templateName: string,
    deadline: number
  ): Promise<{ invoiceId: string; txHash: string }> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "create_from_template",
        nativeToScVal(creator, { type: "address" }),
        nativeToScVal(templateName, { type: "string" }),
        nativeToScVal(deadline, { type: "u64" })
      );

      const result = await this._submitTx(creator, operation);
      const invoiceId = scValToNative(result.returnValue).toString();
      telemetry.recordMethod("createFromTemplate", true, Date.now() - startTime);
      return { invoiceId, txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod("createFromTemplate", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * List all template names for a creator.
   */
  async listTemplates(creator: string): Promise<string[]> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "list_templates",
        nativeToScVal(creator, { type: "address" })
      );

      const account = await this.server.getAccount(this.config.contractId).catch(() => null);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sourceAccount = account ?? ({ accountId: () => this.config.contractId, sequenceNumber: () => "0", incrementSequenceNumber: () => {} } as any);

      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      const simResult = await this.server.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(simResult)) {
        throw new Error(`Simulation failed: ${simResult.error}`);
      }

      const returnVal = (simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
      if (!returnVal) throw new Error("No return value from list_templates");

      const templates = scValToNative(returnVal);
      const result = Array.isArray(templates) ? templates : [];
      telemetry.recordMethod("listTemplates", true, Date.now() - startTime);
      return result;
    } catch (error) {
      telemetry.recordMethod("listTemplates", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Get all recurring invoices for a creator.
   */
  async getRecurringInvoices(creator: string): Promise<Invoice[]> {
    const startTime = Date.now();
    try {
      const page = await this.getInvoicesByCreator(creator);
      const invoices = await Promise.all(page.items.map((id) => this.getInvoice(id)));
      const recurring = invoices.filter((inv) => inv.recurring === true);
      telemetry.recordMethod("getRecurringInvoices", true, Date.now() - startTime);
      return recurring;
    } catch (error) {
      telemetry.recordMethod("getRecurringInvoices", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Cancel a recurring invoice.
   *
   * @returns The transaction hash.
   */
  async cancelRecurring(invoiceId: string, creator: string): Promise<TxResult> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "cancel_invoice",
        nativeToScVal(BigInt(invoiceId), { type: "u64" }),
        nativeToScVal(creator, { type: "address" })
      );

      const result = await this._submitTx(creator, operation);
      telemetry.recordMethod("cancelRecurring", true, Date.now() - startTime);
      return { txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod("cancelRecurring", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Update amounts for a recurring invoice.
   *
   * @returns The transaction hash.
   */
  async updateRecurringAmount(
    invoiceId: string,
    creator: string,
    amounts: bigint[]
  ): Promise<TxResult> {
    const startTime = Date.now();
    try {
      const amountVals = amounts.map((a) => nativeToScVal(a, { type: "i128" }));

      const operation = this.contract.call(
        "update_recurring_amount",
        nativeToScVal(BigInt(invoiceId), { type: "u64" }),
        nativeToScVal(creator, { type: "address" }),
        xdr.ScVal.scvVec(amountVals)
      );

      const result = await this._submitTx(creator, operation);
      telemetry.recordMethod("updateRecurringAmount", true, Date.now() - startTime);
      return { txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod("updateRecurringAmount", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Get invoices created by an address, with cursor-based pagination.
   *
   * @param creator - Stellar address of the creator.
   * @param options - Optional pagination options (cursor, limit). Default page size is 20.
   * @returns A page of invoice IDs with a nextCursor for subsequent pages.
   */
  async getInvoicesByCreator(
    creator: string,
    options: PaginationOptions = {}
  ): Promise<PaginatedResult<string>> {
    const limit = options.limit ?? 20;

    const operation = this.contract.call(
      "get_invoices_by_creator",
      nativeToScVal(creator, { type: "address" })
    );

    const account = await this.server.getAccount(this.config.contractId).catch(() => null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sourceAccount = account ?? ({ accountId: () => this.config.contractId, sequenceNumber: () => "0", incrementSequenceNumber: () => {} } as any);

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simResult = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error(`Simulation failed: ${simResult.error}`);
    }

    const returnVal = (simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (!returnVal) throw new Error("No return value from get_invoices_by_creator");

    const raw = scValToNative(returnVal);
    const allIds: string[] = Array.isArray(raw)
      ? raw.map((id: unknown) => String(id))
      : [];

    const total = allIds.length;
    const startIndex = options.cursor
      ? allIds.indexOf(options.cursor) + 1
      : 0;
    const page = allIds.slice(startIndex, startIndex + limit);
    const nextCursor = startIndex + limit < total ? page[page.length - 1] : null;

    return { items: page, nextCursor, total };
  }

  /**
   * Get invoices where an address is a recipient, with cursor-based pagination.
   *
   * @param recipient - Stellar address of the recipient.
   * @param options   - Optional pagination options (cursor, limit). Default page size is 20.
   * @returns A page of invoice IDs with a nextCursor for subsequent pages.
   */
  async getInvoicesByRecipient(
    recipient: string,
    options: PaginationOptions = {}
  ): Promise<PaginatedResult<string>> {
    const limit = options.limit ?? 20;

    const operation = this.contract.call(
      "get_invoices_by_recipient",
      nativeToScVal(recipient, { type: "address" })
    );

    const account = await this.server.getAccount(this.config.contractId).catch(() => null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sourceAccount = account ?? ({ accountId: () => this.config.contractId, sequenceNumber: () => "0", incrementSequenceNumber: () => {} } as any);

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simResult = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error(`Simulation failed: ${simResult.error}`);
    }

    const returnVal = (simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (!returnVal) throw new Error("No return value from get_invoices_by_recipient");

    const raw = scValToNative(returnVal);
    const allIds: string[] = Array.isArray(raw) ? raw.map((id: unknown) => String(id)) : [];

    const total = allIds.length;
    const startIndex = options.cursor ? allIds.indexOf(options.cursor) + 1 : 0;
    const page = allIds.slice(startIndex, startIndex + limit);
    const nextCursor = startIndex + limit < total ? page[page.length - 1] : null;

    return { items: page, nextCursor, total };
  }

  /**
   * Check the health of the RPC endpoint.
   */
  async checkRPCHealth(): Promise<RPCHealth> {
    return checkRPCHealth(this.server);
  }

  /**
   * Create a group of linked invoices.
   *
   * @returns The new group ID and transaction hash.
   */
  async createGroup(
    creator: string,
    invoiceIds: string[]
  ): Promise<{ groupId: string; txHash: string }> {
    const invoiceIdsBigInt = invoiceIds.map((id) =>
      nativeToScVal(BigInt(id), { type: "u64" })
    );

    const operation = this.contract.call(
      "create_invoice_group",
      nativeToScVal(creator, { type: "address" }),
      xdr.ScVal.scvVec(invoiceIdsBigInt)
    );

    const result = await this._submitTx(creator, operation);
    const groupId = scValToNative(result.returnValue).toString();
    return { groupId, txHash: result.txHash };
  }

  /**
   * Get the status of an invoice group.
   */
  async getGroupStatus(groupId: string): Promise<InvoiceGroup> {
    const operation = this.contract.call(
      "get_invoice_group",
      nativeToScVal(BigInt(groupId), { type: "u64" })
    );

    const account = await this.server.getAccount(this.config.contractId).catch(() => null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sourceAccount = account ?? ({ accountId: () => this.config.contractId, sequenceNumber: () => "0", incrementSequenceNumber: () => {} } as any);

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simResult = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error(`Simulation failed: ${simResult.error}`);
    }

    const returnVal = (simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (!returnVal) throw new Error("No return value from get_invoice_group");

    const raw = scValToNative(returnVal) as Record<string, unknown>;
    return {
      groupId,
      invoiceIds: (raw.invoiceIds as (string | number)[]).map((id) => String(id)),
      allFunded: Boolean(raw.allFunded),
    };
  }

  /**
   * Release all invoices in a group.
   *
   * @returns The transaction hash.
   */
  async releaseGroup(creator: string, groupId: string): Promise<TxResult> {
    const operation = this.contract.call(
      "release_invoice_group",
      nativeToScVal(creator, { type: "address" }),
      nativeToScVal(BigInt(groupId), { type: "u64" })
    );

    const result = await this._submitTx(creator, operation);
    return { txHash: result.txHash };
  }

  // ---------------------------------------------------------------------------
  // Issue #1 — batchPay
  // ---------------------------------------------------------------------------

  /**
   * Pay toward multiple invoices in a single transaction.
   *
   * @param payments - Array of { invoiceId, amount } (must be non-empty)
   * @returns The transaction hash.
   */
  /**
   * Pay toward multiple invoices in a single transaction.
   *
   * @param payer    - Stellar address of the payer (must sign).
   * @param payments - Array of { invoiceId, amount } (must be non-empty).
   * @returns The transaction hash.
   */
  async batchPay(payer: string, payments: BatchPayment[]): Promise<TxResult> {
    if (payments.length === 0) {
      throw new Error("payments array must not be empty");
    }

    for (const p of payments) {
      if (!p.invoiceId || isNaN(Number(p.invoiceId))) {
        throw new Error(`Invalid invoiceId: ${p.invoiceId}`);
      }
    }

    const paymentVals = payments.map((p) => {
      const entries: xdr.ScMapEntry[] = [
        new xdr.ScMapEntry({
          key: nativeToScVal("invoice_id", { type: "symbol" }) as xdr.ScVal,
          val: nativeToScVal(BigInt(p.invoiceId), { type: "u64" }) as xdr.ScVal,
        }),
        new xdr.ScMapEntry({
          key: nativeToScVal("amount", { type: "symbol" }) as xdr.ScVal,
          val: nativeToScVal(p.amount, { type: "i128" }) as xdr.ScVal,
        }),
      ];
      return xdr.ScVal.scvMap(entries);
    });

    const operation = this.contract.call(
      "batch_pay",
      nativeToScVal(payer, { type: "address" }),
      xdr.ScVal.scvVec(paymentVals)
    );

    const result = await this._submitTx(payer, operation);
    return { txHash: result.txHash };
  }

  // ---------------------------------------------------------------------------
  // Issue #2 — subscribeToInvoice
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to live invoice events via Soroban RPC event polling.
   *
   * @param invoiceId - The invoice ID to watch.
   * @param callbacks - Typed event callbacks.
   * @param intervalMs - Poll interval in milliseconds (default: 5000).
   * @returns Unsubscribe function that stops the stream.
   */
  subscribeToInvoice(
    invoiceId: string,
    callbacks: InvoiceEventCallbacks,
    intervalMs?: number
  ): () => void {
    return _subscribeToInvoice(
      this.server,
      this.config.contractId,
      invoiceId,
      callbacks,
      intervalMs
    );
  }

  // ---------------------------------------------------------------------------
  // Issue #3 — offline signing flow
  // ---------------------------------------------------------------------------

  /**
   * Build a transaction and return it as a base64 XDR string.
   * The transaction is simulated and assembled (resource fees injected) but
   * NOT signed or submitted — suitable for air-gapped / offline signing.
   *
   * @param sourceAddress - Stellar address of the transaction source.
   * @param operation     - The contract operation to include.
   * @returns Base64-encoded XDR of the prepared (unsigned) transaction.
   */
  async buildTransaction(
    sourceAddress: string,
    operation: xdr.Operation
  ): Promise<string> {
    const account = await this.server.getAccount(sourceAddress);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simResult = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error(`Simulation failed: ${simResult.error}`);
    }

    const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
    return preparedTx.toXDR();
  }

  /**
   * Submit a signed transaction XDR and wait for confirmation.
   *
   * @param signedXdr - Base64-encoded signed transaction XDR.
   * @returns The transaction hash.
   */
  async submitTransaction(signedXdr: string): Promise<TxResult> {
    const tx = TransactionBuilder.fromXDR(signedXdr, this.config.networkPassphrase);
    const sendResult = await this.server.sendTransaction(tx);

    if (sendResult.status === "ERROR") {
      throw new Error(`Transaction failed: ${JSON.stringify(sendResult.errorResult)}`);
    }

    const txHash = sendResult.hash;
    let getResult = await this.server.getTransaction(txHash);
    let attempts = 0;

    while (
      getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND &&
      attempts < 20
    ) {
      await new Promise((r) => setTimeout(r, 1500));
      getResult = await this.server.getTransaction(txHash);
      attempts++;
    }

    if (getResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      throw new Error(`Transaction not confirmed: ${getResult.status}`);
    }

    return { txHash };
  }

  // ---------------------------------------------------------------------------
  // Issue #4 — dry-run simulation
  // ---------------------------------------------------------------------------

  /**
   * Simulate a createInvoice call without submitting a transaction.
   *
   * @returns The expected invoice ID and estimated fee in stroops.
   * @throws StellarSplitError with the simulation error message on failure.
   */
  async simulateCreateInvoice(
    params: CreateInvoiceParams
  ): Promise<SimulateCreateInvoiceResult> {
    const recipientAddresses = params.recipients.map((r) =>
      nativeToScVal(r.address, { type: "address" })
    );
    const recipientAmounts = params.recipients.map((r) =>
      nativeToScVal(r.amount, { type: "i128" })
    );

    const operation = this.contract.call(
      "create_invoice",
      nativeToScVal(params.creator, { type: "address" }),
      xdr.ScVal.scvVec(recipientAddresses),
      xdr.ScVal.scvVec(recipientAmounts),
      nativeToScVal(params.token, { type: "address" }),
      nativeToScVal(params.deadline, { type: "u64" })
    );

    const account = await this.server.getAccount(params.creator).catch(() => null);
    const sourceAccount = account ?? ({
      accountId: () => params.creator,
      sequenceNumber: () => "0",
      incrementSequenceNumber: () => {},
    } as Parameters<typeof TransactionBuilder>[0]);

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simResult = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error(`Simulation error: ${simResult.error}`);
    }

    const success = simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse;
    const returnVal = success.result?.retval;
    if (!returnVal) throw new Error("No return value from simulate create_invoice");

    const invoiceId = scValToNative(returnVal).toString();
    const fee = success.minResourceFee ?? "0";

    return { invoiceId, fee: fee.toString() };
  }

  /**
   * Simulate a pay call without submitting a transaction.
   *
   * @returns The estimated fee in stroops.
   * @throws StellarSplitError with the simulation error message on failure.
   */
  async simulatePay(params: PayParams): Promise<SimulatePayResult> {
    const operation = this.contract.call(
      "pay",
      nativeToScVal(params.payer, { type: "address" }),
      nativeToScVal(BigInt(params.invoiceId), { type: "u64" }),
      nativeToScVal(params.amount, { type: "i128" })
    );

    const account = await this.server.getAccount(params.payer).catch(() => null);
    const sourceAccount = account ?? ({
      accountId: () => params.payer,
      sequenceNumber: () => "0",
      incrementSequenceNumber: () => {},
    } as Parameters<typeof TransactionBuilder>[0]);

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simResult = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error(`Simulation error: ${simResult.error}`);
    }

    const success = simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse;
    const fee = success.minResourceFee ?? "0";

    return { fee: fee.toString() };
  }

  /**
   * Switch to a different network.
   *
   * @param network - Network name ('testnet', 'mainnet') or custom NetworkConfig
   */
  switchNetwork(network: string | NetworkConfig): void {
    let config: NetworkConfig;

    if (typeof network === "string") {
      const preset = NETWORKS[network];
      if (!preset) {
        throw new Error(`Unknown network: ${network}`);
      }
      config = { ...preset, contractId: this.config.contractId };
    } else {
      config = network;
    }

    this.config = config;
    this.server = new SorobanRpc.Server(config.rpcUrl, {
      allowHttp: config.rpcUrl.startsWith("http://"),
    });
    this.contract = new Contract(config.contractId);
  }

  /**
   * Get all invoices where an address is a recipient.
   */
  private async getInvoicesByRecipient(recipient: string): Promise<Invoice[]> {
    const operation = this.contract.call(
      "get_invoices_by_recipient",
      nativeToScVal(recipient, { type: "address" })
    );

    const account = await this.server.getAccount(this.config.contractId).catch(() => null);
    const sourceAccount = account ?? ({ accountId: () => this.config.contractId, sequenceNumber: () => "0", incrementSequenceNumber: () => {} } as { accountId: () => string; sequenceNumber: () => string; incrementSequenceNumber: () => void });

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simResult = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error(`Simulation failed: ${simResult.error}`);
    }

    const returnVal = (simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (!returnVal) return [];

    const invoices = scValToNative(returnVal);
    if (!Array.isArray(invoices)) return [];

    return invoices.map((inv: Record<string, unknown>, idx: number) =>
      this._parseInvoice(idx.toString(), inv)
    );
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Simulate a view-only (read) contract call. */
  private async _simulateView<T>(operation: xdr.Operation, parseFn: (val: unknown) => T): Promise<T> {
    const account = await this.server.getAccount(this.config.contractId).catch(() => null);
    const sourceAccount = account ?? ({ accountId: () => this.config.contractId, sequenceNumber: () => "0", incrementSequenceNumber: () => {} } as { accountId: () => string; sequenceNumber: () => string; incrementSequenceNumber: () => void });

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simResult = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error(`Simulation failed: ${simResult.error}`);
    }

    const returnVal = (simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (!returnVal) throw new Error("No return value from view call");

    return parseFn(scValToNative(returnVal));
  }

  /** Build, simulate, sign, and submit a transaction. */
  private async _submitTx(
    sourceAddress: string,
    operation: xdr.Operation
  ): Promise<{ txHash: string; returnValue: xdr.ScVal }> {
    const req = { method: "_submitTx", params: [sourceAddress] };
    await runRequestInterceptors(req);

    const startTime = Date.now();
    try {
      const account = await this.server.getAccount(sourceAddress);

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      const simResult = await this.server.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(simResult)) {
        throw new Error(`Simulation failed: ${simResult.error}`);
      }

      const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
      const signedXdr = await (this.config.adapter
        ? this.config.adapter.signTransaction(preparedTx.toXDR(), this.config.networkPassphrase)
        : signTransaction(preparedTx.toXDR(), this.config.networkPassphrase));

      const sendResult = await this.server.sendTransaction(
        TransactionBuilder.fromXDR(signedXdr, this.config.networkPassphrase)
      );

      if (sendResult.status === "ERROR") {
        throw new Error(`Transaction failed: ${JSON.stringify(sendResult.errorResult)}`);
      }

      const txHash = sendResult.hash;
      let getResult = await this.server.getTransaction(txHash);
      let attempts = 0;
      while (
        getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND &&
        attempts < 20
      ) {
        await new Promise((r) => setTimeout(r, 1500));
        getResult = await this.server.getTransaction(txHash);
        attempts++;
      }

      // If still not confirmed, submit a fee-bump transaction with a higher fee
      if (getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
        const multiplier = this.config.feeBumpMultiplier ?? 2;
        const innerTx = TransactionBuilder.fromXDR(
          signedXdr,
          this.config.networkPassphrase
        ) as Parameters<typeof TransactionBuilder.buildFeeBumpTransaction>[2];
        const bumpedFee = String(Math.ceil(Number(BASE_FEE) * multiplier));
        const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
          sourceAddress,
          bumpedFee,
          innerTx,
          this.config.networkPassphrase
        );
        const signedBumpXdr = await (this.config.adapter
          ? this.config.adapter.signTransaction(feeBumpTx.toXDR(), this.config.networkPassphrase)
          : signTransaction(feeBumpTx.toXDR(), this.config.networkPassphrase));
        const bumpSendResult = await this.server.sendTransaction(
          TransactionBuilder.fromXDR(signedBumpXdr, this.config.networkPassphrase)
        );
        if (bumpSendResult.status === "ERROR") {
          throw new Error(`Fee-bump transaction failed: ${JSON.stringify(bumpSendResult.errorResult)}`);
        }
        const bumpHash = bumpSendResult.hash;
        let bumpResult = await this.server.getTransaction(bumpHash);
        let bumpAttempts = 0;
        while (
          bumpResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND &&
          bumpAttempts < 20
        ) {
          await new Promise((r) => setTimeout(r, 1500));
          bumpResult = await this.server.getTransaction(bumpHash);
          bumpAttempts++;
        }
        if (bumpResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
          throw new Error(`Fee-bump transaction not confirmed: ${bumpResult.status}`);
        }
        const bumpReturnValue =
          (bumpResult as SorobanRpc.Api.GetSuccessfulTransactionResponse).returnValue ??
          xdr.ScVal.scvVoid();

        const durationMs = Date.now() - startTime;
        await runResponseInterceptors({ method: "_submitTx", result: { txHash: bumpHash, returnValue: bumpReturnValue }, durationMs });
        recordCall(true);
        return { txHash: bumpHash, returnValue: bumpReturnValue };
      }

      if (getResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`Transaction not confirmed: ${getResult.status}`);
      }

      const returnValue =
        (getResult as SorobanRpc.Api.GetSuccessfulTransactionResponse).returnValue ??
        xdr.ScVal.scvVoid();

      const durationMs = Date.now() - startTime;
      await runResponseInterceptors({ method: "_submitTx", result: { txHash, returnValue }, durationMs });
      recordCall(true);
      return { txHash, returnValue };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      await runResponseInterceptors({ method: "_submitTx", result: undefined, durationMs });
      recordCall(false);
      throw error;
    }
  }

  /** Parse a raw contract map into a typed Invoice. */
  private _parseInvoice(id: string, raw: Record<string, unknown>): Invoice {
    const statusMap: Record<string, InvoiceStatus> = {
      Pending: "Pending",
      Released: "Released",
      Refunded: "Refunded",
    };

    const recipients: Recipient[] = (raw.recipients as string[]).map(
      (addr: string, i: number) => ({
        address: addr,
        amount: BigInt((raw.amounts as unknown[])[i] as string | number),
      })
    );

    const payments: Payment[] = ((raw.payments as unknown[]) ?? []).map(
      (p: unknown) => {
        const pm = p as Record<string, unknown>;
        return {
          payer: pm.payer as string,
          amount: BigInt(pm.amount as string | number),
        };
      }
    );

    return {
      id,
      creator: raw.creator as string,
      recipients,
      token: raw.token as string,
      deadline: Number(raw.deadline),
      funded: BigInt(raw.funded as string | number),
      status: statusMap[raw.status as string] ?? "Pending",
      payments,
      recurring: raw.recurring as boolean | undefined,
    };
  }
}
