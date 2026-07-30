/**
 * Soroban contract deployment pipeline for StellarSplit.
 *
 * Wraps the two-step "upload WASM, then instantiate a contract instance
 * from the uploaded hash" flow behind a single {@link DeployPipeline}
 * class, so callers no longer have to hand-construct the upload/create
 * operations, simulate them for accurate resource fees, and chain the
 * two transactions themselves.
 */

import {
  rpc as SorobanRpc,
  Operation,
  TransactionBuilder,
  BASE_FEE,
  Address,
  Keypair,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import {
  DeploySequenceError,
  SimulationFailedError,
  TransactionFailedError,
  NoReturnValueError,
} from "../errors.js";
import type { DeployOptions, DeployResult } from "../types.js";

/** Maximum number of resubmissions after a `tx_bad_seq` failure. */
const MAX_SEQUENCE_RETRIES = 3;
/** Interval between `getTransaction` polls while awaiting confirmation. */
const POLL_INTERVAL_MS = 1_500;
/** Maximum time to wait for a submitted transaction to confirm. */
const POLL_TIMEOUT_MS = 30_000;

/** Configuration for {@link DeployPipeline}. */
export interface DeployPipelineOptions {
  /** Soroban RPC endpoint URL. */
  rpcUrl: string;
  /** Stellar network passphrase. */
  networkPassphrase: string;
  /** Keypair used to sign and fund upload/instantiate transactions. */
  sourceKeypair: Keypair;
  /** Force plaintext HTTP to the RPC endpoint. Defaults to inferring from the URL scheme. */
  allowHttp?: boolean;
}

/** Internal signal thrown to trigger a sequence-number retry. */
class BadSequenceSignal extends Error {}

/**
 * Deploys Soroban contracts by uploading WASM bytecode and instantiating
 * a contract instance from the resulting hash.
 *
 * Both steps are simulated before submission so the assembled transaction
 * carries accurate footprints and resource fees, and both are retried
 * automatically on `tx_bad_seq` up to {@link MAX_SEQUENCE_RETRIES} times.
 *
 * @example
 * ```typescript
 * const pipeline = new DeployPipeline({
 *   rpcUrl: "https://soroban-testnet.stellar.org",
 *   networkPassphrase: Networks.TESTNET,
 *   sourceKeypair: Keypair.fromSecret(secret),
 * });
 * const wasmHash = await pipeline.upload(wasmBytes);
 * const contractId = await pipeline.instantiate(wasmHash, salt);
 * ```
 */
export class DeployPipeline {
  private readonly server: InstanceType<typeof SorobanRpc.Server>;
  private readonly networkPassphrase: string;
  private readonly sourceKeypair: Keypair;

  constructor(options: DeployPipelineOptions) {
    this.networkPassphrase = options.networkPassphrase;
    this.sourceKeypair = options.sourceKeypair;
    this.server = new SorobanRpc.Server(options.rpcUrl, {
      allowHttp: options.allowHttp ?? options.rpcUrl.startsWith("http://"),
    });
  }

  /**
   * Uploads Soroban contract WASM bytecode to the network.
   *
   * @param wasmBytes - Raw contract bytecode.
   * @returns The hex-encoded hash of the uploaded WASM.
   */
  async upload(wasmBytes: Buffer): Promise<string> {
    const returnValue = await this.executeWithRetry(
      () => Operation.uploadContractWasm({ wasm: wasmBytes }),
      "uploadContractWasm"
    );
    const hashBytes = scValToNative(returnValue) as Buffer;
    return Buffer.from(hashBytes).toString("hex");
  }

  /**
   * Instantiates a contract instance from a previously uploaded WASM hash.
   *
   * Wraps the `CreateContractV2` host function (via
   * `Operation.createCustomContract`), deriving the contract address from
   * the source account's identity and the supplied salt.
   *
   * @param wasmHash - Hex-encoded WASM hash returned by {@link upload}.
   * @param salt - 32-byte salt used to derive the contract address.
   * @returns The deployed contract's address (C...).
   */
  async instantiate(wasmHash: string, salt: Buffer): Promise<string> {
    const returnValue = await this.executeWithRetry(
      () =>
        Operation.createCustomContract({
          address: new Address(this.sourceKeypair.publicKey()),
          wasmHash: Buffer.from(wasmHash, "hex"),
          salt,
        }),
      "createContractV2"
    );
    return scValToNative(returnValue) as string;
  }

  /**
   * Convenience wrapper that uploads WASM and instantiates a contract
   * instance from it in one call.
   */
  async deploy(options: DeployOptions): Promise<DeployResult> {
    const salt = options.salt ?? Buffer.from(Keypair.random().rawPublicKey());
    const wasmHash = await this.upload(options.wasmBytes);
    const contractId = await this.instantiate(wasmHash, salt);
    return { wasmHash, contractId };
  }

  // -------------------------------------------------------------------------
  // Internal: simulate, sign, submit, retry on bad sequence, poll for result
  // -------------------------------------------------------------------------

  private async executeWithRetry(
    buildOperation: () => xdr.Operation,
    stepName: string
  ): Promise<xdr.ScVal> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.executeOnce(buildOperation(), stepName);
      } catch (err) {
        if (!(err instanceof BadSequenceSignal)) {
          throw err;
        }
        attempt += 1;
        if (attempt > MAX_SEQUENCE_RETRIES) {
          throw new DeploySequenceError(stepName, attempt - 1);
        }
      }
    }
  }

  private async executeOnce(operation: xdr.Operation, stepName: string): Promise<xdr.ScVal> {
    const account = await this.server.getAccount(this.sourceKeypair.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simulation = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simulation)) {
      throw new SimulationFailedError(
        `Simulation failed for ${stepName}: ${simulation.error}`,
        stepName,
        simulation.error
      );
    }

    const prepared = SorobanRpc.assembleTransaction(tx, simulation).build();
    prepared.sign(this.sourceKeypair);

    const sendResponse = await this.server.sendTransaction(prepared);

    if (sendResponse.status === "ERROR") {
      const errorDetail = JSON.stringify(sendResponse.errorResult);
      if (looksLikeBadSequence(errorDetail)) {
        throw new BadSequenceSignal();
      }
      throw new TransactionFailedError(
        `${stepName} submission failed: ${errorDetail}`,
        sendResponse.hash,
        errorDetail
      );
    }

    return this.pollForResult(sendResponse.hash, stepName);
  }

  private async pollForResult(hash: string, stepName: string): Promise<xdr.ScVal> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    for (;;) {
      const response = await this.server.getTransaction(hash);

      if (response.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        const returnValue = (response as SorobanRpc.Api.GetSuccessfulTransactionResponse).returnValue;
        if (!returnValue) {
          throw new NoReturnValueError(stepName);
        }
        return returnValue;
      }

      if (response.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        const errorDetail = JSON.stringify(
          (response as SorobanRpc.Api.GetFailedTransactionResponse).resultXdr
        );
        if (looksLikeBadSequence(errorDetail)) {
          throw new BadSequenceSignal();
        }
        throw new TransactionFailedError(`${stepName} transaction failed on-chain`, hash, errorDetail);
      }

      if (Date.now() >= deadline) {
        throw new TransactionFailedError(`${stepName} transaction confirmation timed out`, hash);
      }

      await sleep(POLL_INTERVAL_MS);
    }
  }
}

/** Type-guard-ish check for a `tx_bad_seq` result, mirroring `isSequenceTooOld` in sequenceCache.ts. */
function looksLikeBadSequence(detail: string): boolean {
  const lower = detail.toLowerCase();
  return lower.includes("tx_bad_seq") || lower.includes("bad sequence");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
