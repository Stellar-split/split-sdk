/**
 * Fee Bump Builder — wraps recipient-signed transactions in fee bump envelopes.
 *
 * When a recipient-signed transaction cannot pay its own fee (e.g., the submitter
 * is a new account with no XLM), this module wraps it in a fee bump transaction
 * submitted by a fee-paying account. Uses @stellar/stellar-sdk
 * TransactionBuilder.buildFeeBumpTransaction().
 */

import {
  Transaction,
  TransactionBuilder,
  xdr,
  FeeBumpTransaction,
  Keypair,
} from "@stellar/stellar-sdk";
import { InvalidTransactionTypeError } from "./errors.js";
import { checkPayerReadiness } from "./preflightChecker.js";
import type { PayerReadinessResult } from "./preflightChecker.js";

/**
 * Configuration for fee bump operations.
 */
export interface FeeBumpConfig {
  /** Stellar address of the account that will pay the fee. */
  feeSource: string;
  /** Base fee in stroops. */
  baseFee: string;
  /**
   * Optional multiplier applied to baseFee for surge conditions
   * (e.g., 1.5 = 150% of baseFee). Defaults to 1.0.
   */
  multiplier?: number;
}

/**
 * Build a fee bump transaction wrapping an inner transaction.
 *
 * The inner transaction must be a v1 transaction envelope — v0 envelopes
 * are rejected because fee bump requires the muxed account format.
 *
 * @param innerTx   - The inner Transaction to wrap (must be v1).
 * @param feeSource  - Stellar address of the fee-paying account.
 * @param baseFee    - Base fee in stroops.
 * @param config     - Optional multiplier and additional configuration.
 * @returns A FeeBumpTransaction ready for signing and submission.
 * @throws InvalidTransactionTypeError if the inner transaction is not v1.
 */
export function buildFeeBump(
  innerTx: Transaction,
  feeSource: string,
  baseFee: string,
  networkPassphrase: string,
  config?: FeeBumpConfig,
): FeeBumpTransaction {
  // Validate innerTx is v1 (FeeBump requires muxed account format from v1)
  const envelopeType = innerTx.toEnvelope().switch();
  if (envelopeType !== xdr.EnvelopeType.envelopeTypeTx()) {
    const typeName = String(envelopeType.name);
    throw new InvalidTransactionTypeError(typeName);
  }

  const rawBaseFee = BigInt(baseFee);
  let effectiveFee: string = baseFee;

  // Apply surge multiplier if configured
  if (config?.multiplier !== undefined && config.multiplier > 1) {
    const multiplied = Number(rawBaseFee) * config.multiplier;
    effectiveFee = String(BigInt(Math.ceil(multiplied)));
  }

  // Build the fee bump from the inner transaction
  const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
    Keypair.fromPublicKey(feeSource),
    effectiveFee,
    innerTx,
    networkPassphrase,
  );

  return feeBumpTx;
}

/**
 * Validate that the fee source account is ready to sponsor a fee bump.
 *
 * @param server     - Soroban RPC server instance.
 * @param feeSource  - Stellar address of the fee-paying account.
 * @param baseFee    - Estimated total fee in stroops.
 * @returns Readiness result with optional failure reason.
 */
export async function validateFeeSourceReadiness(
  server: import("@stellar/stellar-sdk").rpc.Server,
  feeSource: string,
  baseFee: string,
): Promise<PayerReadinessResult> {
  return checkPayerReadiness(server, feeSource, BigInt(baseFee), "native");
}

/**
 * Extract the fee bump envelope XDR as a base-64 string.
 * Convenience helper for submission / inspection.
 */
export function feeBumpToXDR(tx: FeeBumpTransaction): string {
  return tx.toXDR();
}
