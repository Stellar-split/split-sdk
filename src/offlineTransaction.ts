/**
 * Offline Transaction Building and Signing for StellarSplit SDK.
 *
 * Supports air-gapped / offline transaction composition, Ed25519 signing,
 * multi-signature collection, and lossless round-trip serialization.
 * Operates with zero network connectivity or external dependencies.
 *
 * Issue #1033
 */

import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Memo,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { ValidationError } from "./errors.js";

// ---------------------------------------------------------------------------
// Pluggable Signer interface
// ---------------------------------------------------------------------------

/**
 * Minimal signer abstraction so offline signing can be delegated to hardware
 * wallets, air-gapped devices, or in-memory keypairs.
 */
export interface Signer {
  /** G... public key of the signer. */
  publicKey(): string;
  /**
   * Sign an arbitrary 32-byte payload (typically a transaction hash).
   * Returns the raw 64-byte Ed25519 signature.
   */
  sign(payload: Buffer): Promise<Buffer> | Buffer;
}

// ---------------------------------------------------------------------------
// Types & Config
// ---------------------------------------------------------------------------

export interface TimeboundsConfig {
  minTime?: number;
  maxTime: number;
}

export type OfflineMemoInput =
  | Memo
  | { type: "text"; value: string }
  | { type: "id"; value: string | bigint }
  | { type: "hash" | "return"; value: Buffer | string };

export interface OfflineTransactionConfig {
  /** Source account G... public key. */
  sourceAddress: string;
  /**
   * Account sequence number before this transaction executes.
   * The built transaction will have sequence = sequenceNumber + 1.
   */
  sequenceNumber: string | bigint | number;
  /** Stellar network passphrase (e.g., Networks.PUBLIC or Networks.TESTNET). */
  networkPassphrase: string;
  /** Base fee in stroops per operation. Default: BASE_FEE (100 stroops). */
  baseFee?: number | string;
  /** Optional timebounds (in Unix seconds). */
  timebounds?: TimeboundsConfig | number;
  /** Optional transaction memo. */
  memo?: OfflineMemoInput;
}

export interface OfflinePaymentParams {
  destination: string;
  amount: string | number | bigint;
  asset?: Asset | string;
  source?: string;
}

export interface OfflineCreateAccountParams {
  destination: string;
  startingBalance: string | number | bigint;
  source?: string;
}

export interface OfflineManageDataParams {
  name: string;
  value: string | Buffer | Uint8Array | null;
  source?: string;
}

export interface OfflineChangeTrustParams {
  asset: Asset;
  limit?: string;
  source?: string;
}

/**
 * Transport package for sharing built/signed offline transactions across air-gapped boundaries.
 */
export interface OfflineTxPackage {
  version: 1;
  xdr: string;
  networkPassphrase: string;
  txHash: string;
  sourceAddress: string;
  sequenceNumber: string;
  fee: string;
  operationCount: number;
  signatures: Array<{ hint: string; signature: string }>;
  isSigned: boolean;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// OfflineTransactionBuilder
// ---------------------------------------------------------------------------

export class OfflineTransactionBuilder {
  private readonly config: OfflineTransactionConfig;
  private readonly operations: xdr.Operation[] = [];
  private _transaction: Transaction | null = null;

  constructor(config: OfflineTransactionConfig) {
    if (!StrKey.isValidEd25519PublicKey(config.sourceAddress)) {
      throw new ValidationError(`Invalid source address for offline builder: ${config.sourceAddress}`);
    }
    if (!config.networkPassphrase || typeof config.networkPassphrase !== "string") {
      throw new ValidationError("networkPassphrase is required for offline builder.");
    }
    this.config = config;
  }

  /** Add a payment operation offline. */
  addPayment(params: OfflinePaymentParams): this {
    this.invalidateBuiltTx();
    if (!StrKey.isValidEd25519PublicKey(params.destination)) {
      throw new ValidationError(`Invalid destination for offline payment: ${params.destination}`);
    }
    const numAmt = Number(params.amount);
    if (!Number.isFinite(numAmt) || numAmt <= 0) {
      throw new ValidationError(`Payment amount must be positive, got: ${params.amount}`);
    }

    const asset = typeof params.asset === "string"
      ? (params.asset === "native" || params.asset === "XLM" ? Asset.native() : new Asset(params.asset, params.source ?? this.config.sourceAddress))
      : (params.asset ?? Asset.native());

    this.operations.push(
      Operation.payment({
        destination: params.destination,
        asset,
        amount: params.amount.toString(),
        source: params.source,
      }),
    );
    return this;
  }

  /** Add a createAccount operation offline. */
  addCreateAccount(params: OfflineCreateAccountParams): this {
    this.invalidateBuiltTx();
    if (!StrKey.isValidEd25519PublicKey(params.destination)) {
      throw new ValidationError(`Invalid destination for offline createAccount: ${params.destination}`);
    }
    const numBal = Number(params.startingBalance);
    if (!Number.isFinite(numBal) || numBal <= 0) {
      throw new ValidationError(`Starting balance must be positive, got: ${params.startingBalance}`);
    }

    this.operations.push(
      Operation.createAccount({
        destination: params.destination,
        startingBalance: params.startingBalance.toString(),
        source: params.source,
      }),
    );
    return this;
  }

  /** Add a manageData operation offline. */
  addManageData(params: OfflineManageDataParams): this {
    this.invalidateBuiltTx();
    if (!params.name || params.name.length === 0) {
      throw new ValidationError("manageData name cannot be empty");
    }
    if (Buffer.byteLength(params.name, "utf8") > 64) {
      throw new ValidationError("manageData name exceeds 64 bytes");
    }

    this.operations.push(
      Operation.manageData({
        name: params.name,
        value: params.value instanceof Uint8Array && !Buffer.isBuffer(params.value)
          ? Buffer.from(params.value)
          : params.value,
        source: params.source,
      }),
    );
    return this;
  }

  /** Add a changeTrust operation offline. */
  addChangeTrust(params: OfflineChangeTrustParams): this {
    this.invalidateBuiltTx();
    if (!params.asset) {
      throw new ValidationError("changeTrust requires an asset");
    }

    this.operations.push(
      Operation.changeTrust({
        asset: params.asset,
        limit: params.limit,
        source: params.source,
      }),
    );
    return this;
  }

  /** Add a raw xdr.Operation offline. */
  addOperation(operation: xdr.Operation): this {
    this.invalidateBuiltTx();
    if (!operation) {
      throw new ValidationError("Cannot add undefined or null operation");
    }
    this.operations.push(operation);
    return this;
  }

  /** Number of operations added so far. */
  getOperationCount(): number {
    return this.operations.length;
  }

  /**
   * Build the Transaction instance completely offline.
   * If already built and no operations have changed, returns the cached transaction.
   */
  build(): Transaction {
    if (this._transaction) {
      return this._transaction;
    }

    if (this.operations.length === 0) {
      throw new ValidationError("Cannot build offline transaction with 0 operations.");
    }
    if (this.operations.length > 100) {
      throw new ValidationError(`Offline transaction contains ${this.operations.length} operations (max: 100).`);
    }

    const sourceAccount = new Account(
      this.config.sourceAddress,
      this.config.sequenceNumber.toString(),
    );

    const baseFee = String(this.config.baseFee ?? BASE_FEE);

    const tb = new TransactionBuilder(sourceAccount, {
      fee: baseFee,
      networkPassphrase: this.config.networkPassphrase,
    });

    for (const op of this.operations) {
      tb.addOperation(op);
    }

    // Attach memo if provided
    if (this.config.memo) {
      const memo = this.resolveMemo(this.config.memo);
      tb.addMemo(memo);
    }

    // Attach timebounds if provided
    if (this.config.timebounds) {
      if (typeof this.config.timebounds === "number") {
        tb.setTimeout(this.config.timebounds);
      } else {
        const minTime = this.config.timebounds.minTime ?? 0;
        const maxTime = this.config.timebounds.maxTime;
        tb.setTimeout(Math.max(1, maxTime - minTime));
      }
    } else {
      tb.setTimeout(300); // 5 minutes default
    }

    this._transaction = tb.build();
    return this._transaction;
  }

  /**
   * Sign the offline transaction using an Ed25519 Keypair or secret seed string.
   * Supports multiple successive calls for multi-signature transactions.
   */
  sign(signer: Keypair | string): this {
    const tx = this.build();
    if (typeof signer === "string") {
      if (!StrKey.isValidEd25519SecretSeed(signer)) {
        throw new ValidationError("Invalid secret key provided for offline signing.");
      }
      const kp = Keypair.fromSecret(signer);
      tx.sign(kp);
    } else if (signer instanceof Keypair) {
      tx.sign(signer);
    } else {
      throw new ValidationError("Signer must be a Keypair or secret seed string.");
    }
    return this;
  }

  /**
   * Sign the built transaction hash using a pluggable `Signer` (or `Keypair`)
   * and attach the resulting signature. This is the offline-friendly path:
   * the signer only ever sees the 32-byte transaction hash, so it can live on
   * an air-gapped device.
   *
   * Supports multiple successive calls for multi-signature transactions.
   */
  async signWith(signer: Signer | Keypair): Promise<this> {
    const tx = this.build();

    let publicKey: string;
    let signature: Buffer;

    if (signer instanceof Keypair) {
      publicKey = signer.publicKey();
      signature = signer.sign(tx.hash());
    } else if (signer && typeof (signer as Signer).sign === "function") {
      publicKey = signer.publicKey();
      if (!StrKey.isValidEd25519PublicKey(publicKey)) {
        throw new ValidationError(`Invalid public key from signer: ${publicKey}`);
      }
      const raw = await signer.sign(tx.hash());
      signature = Buffer.from(raw);
    } else {
      throw new ValidationError("Signer must implement the Signer interface or be a Keypair.");
    }

    if (signature.length !== 64) {
      throw new ValidationError(
        `Invalid signature length: expected 64 bytes, got ${signature.length}`,
      );
    }

    return this.addSignature(publicKey, signature);
  }

  /**
   * Add a raw external signature to the built transaction.
   */
  addSignature(publicKey: string, signature: Buffer | Uint8Array | string): this {
    const tx = this.build();
    if (!StrKey.isValidEd25519PublicKey(publicKey)) {
      throw new ValidationError(`Invalid public key for signature hint: ${publicKey}`);
    }

    const sigBuffer = typeof signature === "string"
      ? Buffer.from(signature, "hex")
      : Buffer.from(signature);

    const keypair = Keypair.fromPublicKey(publicKey);
    const hint = keypair.signatureHint();

    const decSig = new xdr.DecoratedSignature({
      hint,
      signature: sigBuffer,
    });

    tx.signatures.push(decSig);
    return this;
  }

  /**
   * Check whether all attached signatures are cryptographically valid
   * for the given public keys against the offline transaction hash.
   */
  verifySignatures(expectedSignerPublicKeys?: string[]): boolean {
    const tx = this.build();
    if (tx.signatures.length === 0) {
      return false;
    }

    const txHash = tx.hash();

    if (expectedSignerPublicKeys && expectedSignerPublicKeys.length > 0) {
      for (const pk of expectedSignerPublicKeys) {
        const kp = Keypair.fromPublicKey(pk);
        const hint = kp.signatureHint();
        const matchingSig = tx.signatures.find(
          (s) => s.hint().toString("hex") === hint.toString("hex"),
        );
        if (!matchingSig) {
          return false;
        }
        const isValid = kp.verify(txHash, matchingSig.signature());
        if (!isValid) {
          return false;
        }
      }
      return true;
    }

    // Verify all attached signatures match non-empty signature buffers
    return tx.signatures.every((s) => s.signature().length === 64);
  }

  /**
   * Get public key signature hints for all signers that have signed this transaction.
   */
  getSignatureHints(): string[] {
    const tx = this.build();
    return tx.signatures.map((s) => s.hint().toString("hex"));
  }

  /**
   * Get transaction hash in hexadecimal string format.
   */
  getTransactionHash(): string {
    return this.build().hash().toString("hex");
  }

  /**
   * Serialize transaction to standard base64-encoded XDR envelope.
   */
  toXDR(): string {
    return this.build().toXDR();
  }

  /**
   * Serialize transaction and all offline metadata into an `OfflineTxPackage`
   * for reliable transfer across air-gapped systems.
   */
  serializePackage(): OfflineTxPackage {
    const tx = this.build();
    const signatures = tx.signatures.map((s) => ({
      hint: s.hint().toString("hex"),
      signature: s.signature().toString("base64"),
    }));

    return {
      version: 1,
      xdr: tx.toXDR(),
      networkPassphrase: this.config.networkPassphrase,
      txHash: tx.hash().toString("hex"),
      sourceAddress: tx.source,
      sequenceNumber: tx.sequence,
      fee: tx.fee.toString(),
      operationCount: tx.operations.length,
      signatures,
      isSigned: signatures.length > 0,
      createdAt: Date.now(),
    };
  }

  /**
   * Serialize to JSON string.
   */
  serialize(): string {
    return JSON.stringify(this.serializePackage());
  }

  /**
   * Reconstitute an OfflineTransactionBuilder from base64 XDR and passphrase.
   */
  static fromXDR(
    xdrString: string,
    networkPassphrase: string,
  ): OfflineTransactionBuilder {
    if (!xdrString || typeof xdrString !== "string") {
      throw new ValidationError("xdrString must be a non-empty string");
    }
    const tx = TransactionBuilder.fromXDR(xdrString, networkPassphrase) as Transaction;

    const builder = new OfflineTransactionBuilder({
      sourceAddress: tx.source,
      sequenceNumber: BigInt(tx.sequence) - 1n,
      networkPassphrase,
      baseFee: Number(tx.fee) / Math.max(1, tx.operations.length),
    });

    builder._transaction = tx;
    const envelope = tx.toEnvelope();
    const rawOps: xdr.Operation[] =
      envelope.switch().name === "envelopeTypeTxV0"
        ? envelope.v0().tx().operations()
        : envelope.v1().tx().operations();
    for (const op of rawOps) {
      builder.operations.push(op);
    }
    return builder;
  }

  /**
   * Reconstitute an OfflineTransactionBuilder from an OfflineTxPackage or JSON string.
   * Signatures embedded in the XDR envelope are preserved losslessly.
   */
  static deserialize(payload: string | OfflineTxPackage): OfflineTransactionBuilder {
    const pkg: OfflineTxPackage = typeof payload === "string" ? JSON.parse(payload) : payload;
    if (!pkg || pkg.version !== 1) {
      throw new ValidationError(`Unsupported package version: ${pkg?.version}`);
    }
    if (!pkg.xdr || !pkg.networkPassphrase) {
      throw new ValidationError("Offline package is missing xdr or networkPassphrase.");
    }

    const builder = OfflineTransactionBuilder.fromXDR(pkg.xdr, pkg.networkPassphrase);

    // The XDR envelope already carries signatures; re-attach any that are
    // present in the package metadata but missing from the envelope so the
    // round-trip is lossless even for externally-collected signatures.
    if (Array.isArray(pkg.signatures) && pkg.signatures.length > 0) {
      const tx = builder.build();
      const existing = new Set(
        tx.signatures.map((s) => `${s.hint().toString("hex")}:${s.signature().toString("base64")}`),
      );
      for (const sig of pkg.signatures) {
        const key = `${sig.hint}:${sig.signature}`;
        if (existing.has(key)) continue;
        tx.signatures.push(
          new xdr.DecoratedSignature({
            hint: Buffer.from(sig.hint, "hex"),
            signature: Buffer.from(sig.signature, "base64"),
          }),
        );
        existing.add(key);
      }
    }

    return builder;
  }

  private resolveMemo(memoInput: OfflineMemoInput): Memo {
    if (memoInput instanceof Memo) return memoInput;
    switch (memoInput.type) {
      case "text":
        return Memo.text(memoInput.value);
      case "id":
        return Memo.id(memoInput.value.toString());
      case "hash":
        return Memo.hash(memoInput.value);
      case "return":
        return Memo.return(
          typeof memoInput.value === "string" ? memoInput.value : memoInput.value.toString("hex"),
        );
      default:
        throw new ValidationError("Unsupported memo type");
    }
  }

  private invalidateBuiltTx(): void {
    this._transaction = null;
  }
}
