import {
  Contract,
  rpc as SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  xdr,
  Account,
  Transaction,
} from "@stellar/stellar-sdk";
import type { StellarSplitClientConfig } from "./client.js";
import { signTransaction } from "./wallet.js";

/** Builder for composing multi-operation StellarSplit transactions. */
export class StellarSplitTxBuilder {
  private readonly server: SorobanRpc.Server;
  private readonly contract: Contract;
  private readonly config: StellarSplitClientConfig;
  private readonly sourceAddress: string;
  private readonly operations: xdr.Operation[] = [];

  constructor(config: StellarSplitClientConfig, sourceAddress: string) {
    this.config = config;
    this.sourceAddress = sourceAddress;
    const rpcUrl = Array.isArray(config.rpcUrl) ? config.rpcUrl[0]! : config.rpcUrl;
    this.server = new SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
    this.contract = new Contract(config.contractId);
  }

  addPay(invoiceId: string, amount: bigint | number | string): this {
    const op = this.contract.call(
      "pay",
      nativeToScVal(this.sourceAddress, { type: "address" }),
      nativeToScVal(BigInt(invoiceId), { type: "u64" }),
      nativeToScVal(BigInt(amount), { type: "i128" })
    );
    this.operations.push(op);
    return this;
  }

  addRolloverInvoice(
    invoiceId: string,
    newDeadline: number,
    caller: string
  ): this {
    const op = this.contract.call(
      "rollover_invoice",
      nativeToScVal(BigInt(invoiceId), { type: "u64" }),
      nativeToScVal(BigInt(newDeadline), { type: "u64" }),
      nativeToScVal(caller, { type: "address" })
    );
    this.operations.push(op);
    return this;
  }

  addRelease(invoiceId: string): this {
    const op = this.contract.call(
      "release_invoice",
      nativeToScVal(BigInt(invoiceId), { type: "u64" })
    );
    this.operations.push(op);
    return this;
  }

  addRefund(invoiceId: string): this {
    const op = this.contract.call(
      "refund_invoice",
      nativeToScVal(BigInt(invoiceId), { type: "u64" })
    );
    this.operations.push(op);
    return this;
  }

  /**
   * Build an unsigned Transaction using a fallback source account (sequence 0).
   * This is synchronous and suitable for offline signing or inspection.
   */
  build(): Transaction {
    const sourceAccount = ({
      accountId: () => this.sourceAddress,
      sequenceNumber: () => "0",
      incrementSequenceNumber: () => {},
    } as unknown) as Account;

    const tb = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    });

    for (const op of this.operations) {
      tb.addOperation(op);
    }

    tb.setTimeout(30);
    return tb.build();
  }

  /**
   * Sign and submit the composed transaction. Returns transaction hash when confirmed.
   */
  async submit(): Promise<{ txHash: string }> {
    const account = await this.server.getAccount(this.sourceAddress);

    const tb = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    });

    for (const op of this.operations) tb.addOperation(op);
    tb.setTimeout(30);
    const tx = tb.build();

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

    if (getResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      throw new Error(`Transaction not confirmed: ${getResult.status}`);
    }

    return { txHash };
  }
}
