/**
 * Smart Contract Interface Builder
 *
 * Provides a fluent, type-safe builder for constructing Soroban smart-contract
 * method invocations without writing raw XDR by hand. Emits `before:invoke` and
 * `after:invoke` events so callers can observe every invocation without monkey-
 * patching.
 *
 * Issue #963
 */

import {
  Contract,
  nativeToScVal,
  xdr,
  scValToNative,
} from "@stellar/stellar-sdk";
import type { xdr as xdrNS } from "@stellar/stellar-sdk";
import { TypedEventEmitter } from "./events/TypedEventEmitter.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single parameter added to the invocation. */
export interface ContractParam {
  /** Logical name used for documentation / introspection. */
  name: string;
  /** The ScVal-compatible JS value. */
  value: unknown;
}

/** Metadata describing a single contract method entry-point. */
export interface ContractMethodSpec {
  /** Contract method name as it appears on-chain. */
  name: string;
  /** Human-readable description used in generated docs. */
  description?: string;
  /** Ordered parameter specifications. */
  params: Array<{ name: string; description?: string }>;
}

/** Options passed to {@link ContractInterfaceBuilder.build}. */
export interface BuildOptions {
  /**
   * When true, the built operation is added to a running list that can be
   * retrieved with {@link ContractInterfaceBuilder.getBuiltOperations}.
   * Defaults to `false`.
   */
  record?: boolean;
}

/** Events emitted by {@link ContractInterfaceBuilder}. */
export interface ContractInterfaceBuilderEvents {
  /** Emitted just before `build()` encodes the operation. */
  "before:build": { method: string; params: ContractParam[] };
  /** Emitted immediately after `build()` returns. */
  "after:build": { method: string; operation: xdr.Operation };
}

// ---------------------------------------------------------------------------
// Main class
// ---------------------------------------------------------------------------

/**
 * Fluent builder for Soroban `InvokeContractFunction` operations.
 *
 * @example
 * ```ts
 * const builder = new ContractInterfaceBuilder(contractId);
 * const op = builder
 *   .method("create_invoice")
 *   .param("creator",   publicKey)
 *   .param("deadline",  deadline)
 *   .build();
 * ```
 */
export class ContractInterfaceBuilder extends TypedEventEmitter<ContractInterfaceBuilderEvents> {
  private readonly _contract: Contract;
  private _method: string | null = null;
  private _params: ContractParam[] = [];
  private _builtOps: xdr.Operation[] = [];
  private _specs: Map<string, ContractMethodSpec> = new Map();

  /**
   * @param contractId - Deployed Stellar contract ID (strkey format).
   */
  constructor(contractId: string) {
    super();
    this._contract = new Contract(contractId);
  }

  // -------------------------------------------------------------------------
  // Method / param selection
  // -------------------------------------------------------------------------

  /**
   * Set the contract method to call. Resets any previously added params.
   *
   * @param name - Method name, e.g. `"create_invoice"`.
   */
  method(name: string): this {
    this._method = name;
    this._params = [];
    return this;
  }

  /**
   * Add a parameter to the current invocation.
   *
   * @param name  - Parameter label (used for introspection only).
   * @param value - JS value that will be converted to an ScVal.
   */
  param(name: string, value: unknown): this {
    if (!this._method) {
      throw new Error(
        "ContractInterfaceBuilder: call .method() before .param()",
      );
    }
    this._params.push({ name, value });
    return this;
  }

  // -------------------------------------------------------------------------
  // Schema / spec registration
  // -------------------------------------------------------------------------

  /**
   * Register a human-readable spec for a method. Useful for generating
   * documentation or validating calls at build time.
   *
   * @param spec - {@link ContractMethodSpec} describing the method.
   */
  registerSpec(spec: ContractMethodSpec): this {
    this._specs.set(spec.name, spec);
    return this;
  }

  /**
   * Retrieve the spec for a method (if registered).
   *
   * @param name - Method name.
   */
  getSpec(name: string): ContractMethodSpec | undefined {
    return this._specs.get(name);
  }

  /**
   * Return all registered method specs.
   */
  listSpecs(): ContractMethodSpec[] {
    return [...this._specs.values()];
  }

  // -------------------------------------------------------------------------
  // Build
  // -------------------------------------------------------------------------

  /**
   * Encode the current method + params into a Stellar `xdr.Operation` ready
   * to be included in a `TransactionBuilder`.
   *
   * Emits `before:build` (with the method name and params array) and
   * `after:build` (with the produced operation) around the encoding step.
   *
   * @param options - {@link BuildOptions}.
   * @returns The encoded `xdr.Operation`.
   * @throws {Error} if no method has been selected.
   */
  build(options: BuildOptions = {}): xdr.Operation {
    if (!this._method) {
      throw new Error(
        "ContractInterfaceBuilder: no method selected — call .method() first",
      );
    }

    this.emit("before:build", {
      method: this._method,
      params: [...this._params],
    });

    // A plain JS `number` param is encoded as a u32 so it round-trips back
    // to a `number` on decode; a `bigint` param keeps the default inference
    // (i128), preserving values outside the u32/safe-integer range.
    const scArgs = this._params.map((p) =>
      typeof p.value === "number"
        ? nativeToScVal(p.value, { type: "u32" })
        : nativeToScVal(p.value),
    );
    const operation = this._contract.call(this._method, ...scArgs);

    this.emit("after:build", { method: this._method, operation });

    if (options.record) {
      this._builtOps.push(operation);
    }

    // Reset for next use
    const method = this._method;
    this._method = null;
    this._params = [];

    return operation;
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  /**
   * Return all operations built with `{ record: true }`.
   */
  getBuiltOperations(): xdr.Operation[] {
    return [...this._builtOps];
  }

  /**
   * Clear the recorded operations list.
   */
  clearBuiltOperations(): void {
    this._builtOps = [];
  }

  /**
   * Decode a previously built operation back to its logical structure.
   * Useful for logging and debugging.
   *
   * @param operation - An `xdr.Operation` produced by this builder.
   * @returns `{ method, args }` where `args` are native JS values.
   */
  static decode(operation: xdr.Operation): {
    method: string;
    args: unknown[];
  } {
    const body = operation.body();
    if (body.switch().name !== "invokeHostFunction") {
      throw new Error(
        "ContractInterfaceBuilder.decode: expected an InvokeHostFunction operation",
      );
    }
    const hostFn = body.invokeHostFunctionOp().hostFunction();
    if (hostFn.switch().name !== "hostFunctionTypeInvokeContract") {
      throw new Error(
        "ContractInterfaceBuilder.decode: expected a contract invocation",
      );
    }
    const invokeContract = hostFn.invokeContract();
    const methodName = invokeContract.functionName().toString();
    const args = invokeContract.args().map(scValToNative);
    return { method: methodName, args };
  }
}

// ---------------------------------------------------------------------------
// Convenience factory
// ---------------------------------------------------------------------------

/**
 * Create a {@link ContractInterfaceBuilder} pre-configured with common
 * StellarSplit contract method specs.
 *
 * @param contractId - Deployed contract ID.
 */
export function createStellarSplitInterfaceBuilder(
  contractId: string,
): ContractInterfaceBuilder {
  const builder = new ContractInterfaceBuilder(contractId);

  builder
    .registerSpec({
      name: "create_invoice",
      description: "Create a new invoice on-chain",
      params: [
        { name: "creator", description: "Creator public key" },
        { name: "recipients", description: "Array of (address, amount) pairs" },
        { name: "token", description: "Token contract ID" },
        { name: "deadline", description: "Unix timestamp in seconds" },
      ],
    })
    .registerSpec({
      name: "pay",
      description: "Pay toward an existing invoice",
      params: [
        { name: "payer", description: "Payer public key" },
        { name: "invoice_id", description: "Invoice ID (u64)" },
        { name: "amount", description: "Payment amount in stroops" },
      ],
    })
    .registerSpec({
      name: "release",
      description: "Release funds to recipients",
      params: [
        { name: "invoice_id", description: "Invoice ID (u64)" },
        { name: "released_by", description: "Releaser public key" },
      ],
    })
    .registerSpec({
      name: "refund",
      description: "Refund all payments to original payers",
      params: [
        { name: "invoice_id", description: "Invoice ID (u64)" },
        { name: "refunded_by", description: "Refunder public key" },
      ],
    });

  return builder;
}
