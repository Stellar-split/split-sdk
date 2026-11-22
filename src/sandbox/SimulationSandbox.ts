/**
 * SimulationSandbox — forks the current ledger state via `simulateTransaction`
 * calls and lets sequences of SDK operations run against the forked snapshot
 * without ever touching the network with a real `sendTransaction`.
 *
 * `SimulationSandbox.fork(client)` returns a `SandboxClient` proxy of a
 * `StellarSplitClient`: every mutating method (createInvoice, pay, ...) still
 * runs its normal argument encoding, telemetry and audit logic, and still
 * calls the real (or injected) RPC's `simulateTransaction` for realistic
 * cost/event reporting — but the actual network submission step
 * (`_submitTx`, the SDK's sole seam that calls `sendTransaction`) is
 * replaced with a simulation-only implementation for the duration of the
 * call, so nothing is ever actually broadcast. A local ledger diff records
 * each mutating call so that later calls in the same sandbox session can
 * observe earlier ones (e.g. a `pay` referencing an `invoiceId` returned by
 * an earlier `createInvoice`).
 */

import { rpc as SorobanRpc, TransactionBuilder, BASE_FEE, xdr } from "@stellar/stellar-sdk";
import type { Account, Transaction } from "@stellar/stellar-sdk";
import { parseSorobanError } from "../errors.js";
import type { StellarSplitClient } from "../client.js";

/** Resource cost reported by the Soroban simulation RPC for a single call. */
export interface SimulationCost {
  cpuInsns: number;
  memBytes: number;
}

/** Result of running one SDK operation through a {@link SimulationSandbox}. */
export interface SimulationResult<T = unknown> {
  success: boolean;
  value?: T;
  cost: SimulationCost;
  events: xdr.DiagnosticEvent[];
  /** Present when `success` is `false`. */
  error?: string;
}

/** A single locally-tracked payment against a sandboxed invoice. */
export interface SandboxPaymentRecord {
  step: number;
  method: string;
  args: unknown[];
}

/** A single locally-tracked invoice created within a sandbox session. */
export interface SandboxInvoiceRecord {
  invoiceId: string;
  createdAtStep: number;
  createArgs: unknown[];
  payments: SandboxPaymentRecord[];
}

/** One entry in the sandbox's call log, in call order. */
export interface SandboxCallLogEntry {
  step: number;
  method: string;
  args: unknown[];
  success: boolean;
  referencedInvoiceId?: string;
}

/** The full local ledger diff accumulated by a sandbox session. */
export interface SandboxLedgerDiff {
  invoices: Record<string, SandboxInvoiceRecord>;
  callLog: SandboxCallLogEntry[];
}

/** Mutating `StellarSplitClient` methods that get routed through simulation. */
const MUTATING_METHODS = new Set<string>([
  "createInvoice",
  "pay",
  "cloneInvoice",
  "payWithAttestation",
  "createInvoiceBatch",
  "batchCreateInvoices",
  "batchPay",
  "disputeInvoice",
  "raiseDispute",
  "resolveDispute",
  "submitArbiterVote",
  "voteDispute",
  "addDisputeEvidence",
  "bulkCancel",
  "bulkArchive",
  "createGroup",
  "releaseGroup",
  "cancelRecurring",
  "updateRecurringAmount",
  "createFromTemplate",
  "saveTemplate",
]);

/** Proxy view of a client where every mutating method returns a {@link SimulationResult}. */
export type SandboxClient<C> = {
  [K in keyof C]: C[K] extends (...args: infer A) => Promise<infer R>
    ? (...args: A) => Promise<SimulationResult<R>>
    : C[K];
};

/** Minimal surface of the SDK's internal RPC transport this sandbox depends on. */
interface MinimalRpc {
  getAccount(address: string): Promise<Account>;
  simulateTransaction(tx: Transaction): Promise<SorobanRpc.Api.SimulateTransactionResponse>;
}

function emptyCost(): SimulationCost {
  return { cpuInsns: 0, memBytes: 0 };
}

function extractCost(sim: SorobanRpc.Api.SimulateTransactionResponse): SimulationCost {
  if (!SorobanRpc.Api.isSimulationSuccess(sim)) return emptyCost();
  const resources = sim.transactionData.build().resources();
  return {
    cpuInsns: Number(resources.instructions()),
    memBytes: Number(resources.readBytes()) + Number(resources.writeBytes()),
  };
}

const BIGINT_TAG = "__sandbox_bigint__";

function cloneDiff(diff: SandboxLedgerDiff): SandboxLedgerDiff {
  const json = JSON.stringify(diff, (_key, value) =>
    typeof value === "bigint" ? { [BIGINT_TAG]: value.toString() } : value,
  );
  return JSON.parse(json, (_key, value) => {
    if (value && typeof value === "object" && BIGINT_TAG in value) {
      return BigInt((value as Record<string, string>)[BIGINT_TAG]!);
    }
    return value;
  }) as SandboxLedgerDiff;
}

function fakeTxHash(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Best-effort extraction of an `invoiceId` string from method args/return values. */
function extractInvoiceId(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "invoiceId" in value) {
    const id = (value as { invoiceId?: unknown }).invoiceId;
    if (typeof id === "string") return id;
  }
  return undefined;
}

/** Internal client shape this module reaches into (TS `private` fields are not runtime-enforced). */
interface ClientInternals {
  _submitTx: (
    sourceAddress: string,
    operation: xdr.Operation,
    priority?: unknown,
  ) => Promise<{ txHash: string; returnValue: xdr.ScVal }>;
  config: { networkPassphrase: string };
  server: MinimalRpc;
}

export class SimulationSandbox {
  private _diff: SandboxLedgerDiff = { invoices: {}, callLog: [] };
  private _step = 0;
  private _lastSim: SorobanRpc.Api.SimulateTransactionResponse | null = null;

  // Indirection to defeat TS's control-flow narrowing of `this._lastSim` across
  // the `await original.apply(...)` boundary — the field is actually mutated by
  // the `sandboxSubmitTx` closure during that await, which the narrower can't see.
  private _readLastSim(): SorobanRpc.Api.SimulateTransactionResponse | null {
    return this._lastSim;
  }

  /** Fork `client` into a sandboxed proxy. All state accumulates on this sandbox instance. */
  static fork(client: StellarSplitClient): SandboxClient<StellarSplitClient> {
    return new SimulationSandbox().attach(client);
  }

  /**
   * Side-effect-free fork used by the unified transaction simulator.
   *
   * Returns a fresh sandbox plus a proxy of `client` whose mutating methods run
   * against a forked ledger snapshot: each call still performs its normal
   * argument encoding, telemetry and audit logic and still invokes the RPC's
   * `simulateTransaction` for realistic cost/event reporting, but the SDK's
   * sole submission seam (`_submitTx`) is swapped for a simulation-only
   * implementation for the duration of the call. `sendTransaction` is therefore
   * **never** called and nothing is ever broadcast to the network. Earlier calls
   * in the same session are observable to later ones via the accumulated
   * {@link SandboxLedgerDiff}.
   */
  static forkForSimulation(client: StellarSplitClient): {
    sandbox: SimulationSandbox;
    client: SandboxClient<StellarSplitClient>;
  } {
    const sandbox = new SimulationSandbox();
    return { sandbox, client: sandbox.attach(client) };
  }

  /** Rebuild a sandbox from a previously captured {@link snapshot}. */
  static restore(snapshot: SandboxLedgerDiff): SimulationSandbox {
    const sandbox = new SimulationSandbox();
    sandbox._diff = cloneDiff(snapshot);
    sandbox._step = sandbox._diff.callLog.reduce((max, entry) => Math.max(max, entry.step), 0);
    return sandbox;
  }

  /** Attach this sandbox instance to `client`, returning the sandboxed proxy. */
  attach(client: StellarSplitClient): SandboxClient<StellarSplitClient> {
    const internals = client as unknown as ClientInternals;
    const realRpc = internals.server;

    const sandboxSubmitTx = async (
      sourceAddress: string,
      operation: xdr.Operation,
    ): Promise<{ txHash: string; returnValue: xdr.ScVal }> => {
      const account = await realRpc.getAccount(sourceAddress);
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: internals.config.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      const sim = await realRpc.simulateTransaction(tx);
      this._lastSim = sim;

      if (SorobanRpc.Api.isSimulationError(sim)) {
        throw parseSorobanError(sim.error);
      }

      const returnValue = SorobanRpc.Api.isSimulationSuccess(sim)
        ? (sim.result?.retval ?? xdr.ScVal.scvVoid())
        : xdr.ScVal.scvVoid();

      return { txHash: fakeTxHash(), returnValue };
    };

    const runIntercepted = async (
      method: string,
      original: (...args: unknown[]) => Promise<unknown>,
      target: StellarSplitClient,
      args: unknown[],
    ): Promise<SimulationResult<unknown>> => {
      const hadOwnSubmitTx = Object.prototype.hasOwnProperty.call(internals, "_submitTx");
      const savedSubmitTx = internals._submitTx;
      internals._submitTx = sandboxSubmitTx;
      this._lastSim = null;

      const step = ++this._step;
      try {
        const value = await original.apply(target, args);
        const sim = this._readLastSim();
        const result: SimulationResult<unknown> = {
          success: true,
          value,
          cost: sim ? extractCost(sim) : emptyCost(),
          events: sim?.events ?? [],
        };
        this._record(step, method, args, value, true);
        return result;
      } catch (error) {
        const sim = this._readLastSim();
        const result: SimulationResult<unknown> = {
          success: false,
          cost: sim ? extractCost(sim) : emptyCost(),
          events: sim?.events ?? [],
          error: error instanceof Error ? error.message : String(error),
        };
        this._record(step, method, args, undefined, false);
        return result;
      } finally {
        if (hadOwnSubmitTx) {
          internals._submitTx = savedSubmitTx;
        } else {
          delete (internals as { _submitTx?: unknown })._submitTx;
        }
      }
    };

    return new Proxy(client, {
      get: (target, prop, receiver) => {
        const original = Reflect.get(target, prop, receiver);
        if (
          typeof prop !== "string" ||
          typeof original !== "function" ||
          !MUTATING_METHODS.has(prop)
        ) {
          return original;
        }
        const bound = original as (...args: unknown[]) => Promise<unknown>;
        return (...args: unknown[]) => runIntercepted(prop, bound, target, args);
      },
    }) as unknown as SandboxClient<StellarSplitClient>;
  }

  private _record(
    step: number,
    method: string,
    args: unknown[],
    value: unknown,
    success: boolean,
  ): void {
    const entry: SandboxCallLogEntry = { step, method, args, success };

    if (success && method === "createInvoice") {
      const invoiceId = extractInvoiceId(value);
      if (invoiceId) {
        this._diff.invoices[invoiceId] = {
          invoiceId,
          createdAtStep: step,
          createArgs: args,
          payments: [],
        };
        entry.referencedInvoiceId = invoiceId;
      }
    } else if (success && (method === "pay" || method === "payWithAttestation")) {
      const invoiceId = extractInvoiceId(args[0]);
      if (invoiceId) {
        entry.referencedInvoiceId = invoiceId;
        const invoice = this._diff.invoices[invoiceId];
        if (invoice) {
          invoice.payments.push({ step, method, args });
        }
      }
    }

    this._diff.callLog.push(entry);
  }

  /** Look up the locally-accumulated state for a sandboxed invoice, if any. */
  getInvoiceState(invoiceId: string): SandboxInvoiceRecord | undefined {
    return this._diff.invoices[invoiceId];
  }

  /** Clear all accumulated local state. */
  reset(): void {
    this._diff = { invoices: {}, callLog: [] };
    this._step = 0;
  }

  /** Serialize the accumulated ledger diff to a plain JSON-safe object. */
  snapshot(): SandboxLedgerDiff {
    return cloneDiff(this._diff);
  }
}
