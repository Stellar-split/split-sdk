/**
 * StellarSplitClient — TypeScript client for the StellarSplit Soroban contract.
 *
 * Wraps @stellar/stellar-sdk contract invocation with typed methods.
 */

import {
  Contract,
  rpc as SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { signTransaction } from "./wallet.js";
import { checkRPCHealth } from "./health.js";
import type {
  CreateInvoiceParams,
  Invoice,
  InvoiceStatus,
  Payment,
  PayParams,
  Recipient,
  RPCHealth,
} from "./types.js";

/** Configuration for StellarSplitClient. */
export interface StellarSplitClientConfig {
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
    return { invoiceId, txHash: result.txHash };
  }

  /**
   * Pay toward an invoice.
   *
   * @returns The transaction hash.
   */
  async pay(params: PayParams): Promise<TxResult> {
    const operation = this.contract.call(
      "pay",
      nativeToScVal(params.payer, { type: "address" }),
      nativeToScVal(BigInt(params.invoiceId), { type: "u64" }),
      nativeToScVal(params.amount, { type: "i128" })
    );

    const result = await this._submitTx(params.payer, operation);
    return { txHash: result.txHash };
  }

  /**
   * Fetch an invoice by ID.
   */
  async getInvoice(invoiceId: string): Promise<Invoice> {
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

    return this._parseInvoice(invoiceId, scValToNative(returnVal));
  }

  /**
   * Fetch all payments for an invoice.
   */
  async getPayments(invoiceId: string): Promise<Payment[]> {
    const invoice = await this.getInvoice(invoiceId);
    return invoice.payments;
  }

  /**
   * Check the health of the RPC endpoint.
   */
  async checkRPCHealth(): Promise<RPCHealth> {
    return checkRPCHealth(this.server);
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
    const signedXdr = await signTransaction(
      preparedTx.toXDR(),
      this.config.networkPassphrase
    );

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
    };
  }
}
