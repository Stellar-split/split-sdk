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
import type { WalletAdapter } from "./adapters/types.js";
import type {
  ApprovalResult,
  CreateInvoiceParams,
  Invoice,
  InvoiceAnalytics,
  InvoiceStatus,
  Payment,
  PayParams,
  Recipient,
  InvoiceTemplate,
} from "./types.js";

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

/** Result of a transaction submission. */
export interface TxResult {
  txHash: string;
}

export class StellarSplitClient {
  private server: SorobanRpc.Server;
  private contract: Contract;
  private config: StellarSplitClientConfig;

  constructor(config: StellarSplitClientConfig) {
    this.config = config;
    this.server = new SorobanRpc.Server(config.rpcUrl, {
      allowHttp: config.rpcUrl.startsWith("http://"),
    });
    this.contract = new Contract(config.contractId);

    if (config.telemetry) {
      telemetry.init(config.telemetry);
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
   * Check the payer's USDC allowance for the contract and submit an approve
   * transaction if the allowance is insufficient.
   *
   * @param payer   - Stellar address of the payer.
   * @param tokenId - USDC SAC contract address.
   * @param amount  - Required allowance in stroops.
   * @returns `{ approved: true }` when allowance is already sufficient, or
   *          `{ approved: true, txHash }` after submitting an approval tx.
   */
  async checkAndApproveUSDC(
    payer: string,
    tokenId: string,
    amount: bigint
  ): Promise<ApprovalResult> {
    const tokenContract = new Contract(tokenId);

    // Simulate allowance(payer, contractId) on the token SAC
    const allowanceOp = tokenContract.call(
      "allowance",
      new Address(payer).toScVal(),
      nativeToScVal(this.config.contractId, { type: "address" })
    );

    const account = await this.server.getAccount(payer);
    const simTx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(allowanceOp)
      .setTimeout(30)
      .build();

    const simResult = await this.server.simulateTransaction(simTx);
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error(`Allowance simulation failed: ${simResult.error}`);
    }

    const retval = (simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    const allowance: bigint = retval ? BigInt(scValToNative(retval) as string | number) : 0n;

    if (allowance >= amount) {
      return { approved: true };
    }

    // Submit approve(payer, contractId, amount)
    const approveOp = tokenContract.call(
      "approve",
      new Address(payer).toScVal(),
      nativeToScVal(this.config.contractId, { type: "address" }),
      nativeToScVal(amount, { type: "i128" }),
      nativeToScVal(0, { type: "u32" }) // expiration_ledger: 0 means no expiry
    );

    const result = await this._submitTx(payer, approveOp);
    return { approved: true, txHash: result.txHash };
  }

  /**
   * Fetch an invoice by ID.
   */
  async getInvoice(invoiceId: string): Promise<Invoice> {
    const startTime = Date.now();
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
      return invoice;
    } catch (error) {
      telemetry.recordMethod("getInvoice", false, Date.now() - startTime);
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
      const invoices = await this.getInvoicesByCreator(creator);
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
   * Get aggregate analytics for an address (as creator and recipient).
   */
  async getAnalytics(address: string): Promise<InvoiceAnalytics> {
    const [created, received] = await Promise.all([
      this.getInvoicesByCreator(address),
      this.getInvoicesByRecipient(address),
    ]);

    const totalVolumeCreated = created.reduce((sum, inv) => sum + inv.funded, 0n);
    const totalVolumeReceived = received.reduce((sum, inv) => sum + inv.funded, 0n);

    const settled = created.filter((inv) => inv.status === "Released" || inv.status === "Refunded");
    const released = settled.filter((inv) => inv.status === "Released").length;
    const successRate = settled.length > 0 ? released / settled.length : 0;

    const avgAmount = created.length > 0 ? totalVolumeCreated / BigInt(created.length) : 0n;

    return {
      totalCreated: created.length,
      totalReceived: received.length,
      totalVolumeCreated,
      totalVolumeReceived,
      successRate,
      avgAmount,
    };
  }

  /**
   * Get all invoices created by an address.
   */
  private async getInvoicesByCreator(creator: string): Promise<Invoice[]> {
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

    const invoices = scValToNative(returnVal);
    if (!Array.isArray(invoices)) return [];

    return invoices.map((inv: Record<string, unknown>, idx: number) =>
      this._parseInvoice(idx.toString(), inv)
    );
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

  /** Build, simulate, sign, and submit a transaction. */
  private async _submitTx(
    sourceAddress: string,
    operation: xdr.Operation
  ): Promise<{ txHash: string; returnValue: xdr.ScVal }> {
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
      return { txHash: bumpHash, returnValue: bumpReturnValue };
    }

    if (getResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      throw new Error(`Transaction not confirmed: ${getResult.status}`);
    }

    const returnValue =
      (getResult as SorobanRpc.Api.GetSuccessfulTransactionResponse).returnValue ??
      xdr.ScVal.scvVoid();
    return { txHash, returnValue };
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
