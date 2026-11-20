import { rpc as SorobanRpc, Transaction } from "@stellar/stellar-sdk";
import {
  FootprintLogger,
  optimizeFootprint,
} from "../soroban/footprint.js";
import {
  TransactionVerificationError,
  TransactionVerificationOptions,
  TransactionVerifier,
  verifyTransaction,
} from "./verify.js";

/** The minimal RPC surface needed to submit a transaction. */
export type SubmitServer = {
  submitTransaction(
    tx: Transaction | string,
    opts?: Record<string, unknown>,
  ): Promise<SorobanRpc.Api.SendTransactionResponse>;
};

export interface SubmitTransactionOptions {
  /**
   * When true (default), the transaction's declared footprint is trimmed to
   * the minimal key set reported by the simulation result before submission.
   * Pass `{ optimizeFootprint: false }` to submit the transaction exactly as
   * built.
   */
  optimizeFootprint?: boolean;
  /** Receives debug-level diagnostics for keys pruned by the optimizer. */
  logger?: FootprintLogger;
  /**
   * Enables pre-submit transaction verification (issue #1260).
   *
   * - `true` runs the default validation rules.
   * - A `TransactionVerifier` instance runs its configured rules.
   * - A `TransactionVerificationOptions` object runs the default rules plus
   *   any custom rules supplied.
   *
   * When omitted (default), no verification is performed and behavior is
   * unchanged. Verification runs after footprint optimization, so the
   * transaction that is verified is the one that gets submitted. If
   * verification fails, a `TransactionVerificationError` is thrown and the
   * transaction is not submitted.
   */
  verify?: boolean | TransactionVerifier | TransactionVerificationOptions;
}

/**
 * Submits a Soroban transaction through the given server, running the
 * footprint optimizer (issue #588) immediately before submission unless it is
 * explicitly disabled.
 *
 * @param server The RPC server (or mock) used to submit the transaction.
 * @param tx     The (prepared) Soroban transaction to submit.
 * @param sim    The successful simulation response for `tx`; provides the
 *               minimal footprint used by the optimizer.
 * @returns      The send-transaction response.
 */
export async function submitTransaction(
  server: SubmitServer,
  tx: Transaction,
  sim: SorobanRpc.Api.SimulateTransactionSuccessResponse,
  options: SubmitTransactionOptions = {},
): Promise<SorobanRpc.Api.SendTransactionResponse> {
  const optimize = options.optimizeFootprint !== false;
  const toSubmit = optimize
    ? optimizeFootprint(tx, sim, { logger: options.logger })
    : tx;

  if (options.verify) {
    const verifier =
      options.verify instanceof TransactionVerifier
        ? options.verify
        : new TransactionVerifier(
            options.verify === true ? {} : options.verify,
          );
    const result = verifier.verify(toSubmit);
    if (!result.valid) {
      throw new TransactionVerificationError(result);
    }
  }

  return server.submitTransaction(toSubmit);
}
