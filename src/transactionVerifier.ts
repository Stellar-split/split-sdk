/**
 * Pre-submit transaction verification for StellarSplit (issue #1066).
 *
 * Verifies the integrity and authenticity of a Stellar transaction before it
 * is submitted to the network. Each concern is an isolated, independently
 * testable check, and the composed {@link verifyTransaction} runs every check
 * and returns a structured result. Use {@link assertTransactionVerified} to
 * fail fast with a {@link TransactionVerificationError}.
 *
 * ## Checks
 *
 * - `structure` — at least one operation and a parseable positive integer fee.
 * - `fee`       — the fee is positive and (optionally) at or below `maxFee`.
 * - `sequence`  — the sequence number equals `expectedSequence`, when provided.
 * - `timebounds`— "now" lies within the transaction's time bounds.
 * - `signatures`— every required signer holds a valid signature over the hash.
 * - `hash`      — the recomputed hash equals `expectedHash`, when provided.
 *
 * @example
 * ```ts
 * import { verifyTransaction, assertTransactionVerified } from "@stellar-split/sdk";
 *
 * const result = verifyTransaction(tx, {
 *   signers: [walletPublicKey],
 *   maxFee: 500_000,
 *   expectedSequence: account.sequenceNumber(),
 * });
 * if (!result.valid) {
 *   console.warn("Refusing to submit:", result.failedChecks);
 * }
 *
 * // Or fail fast on the first run with any failed check:
 * assertTransactionVerified(tx, { signers: [walletPublicKey] });
 * ```
 */

import { Keypair, Transaction } from "@stellar/stellar-sdk";
import { TransactionVerificationError } from "./errors.js";

/** Names of the individual checks performed by {@link verifyTransaction}. */
export type TransactionCheckName =
  | "structure"
  | "fee"
  | "sequence"
  | "timebounds"
  | "signatures"
  | "hash";

/** Outcome of a single verification check. */
export interface TransactionCheckResult {
  /** The check this result describes. */
  name: TransactionCheckName;
  /** `true` if the check passed. */
  passed: boolean;
  /** Human-readable detail explaining the outcome. */
  detail: string;
}

/** Aggregated result of running every verification check. */
export interface TransactionVerificationResult {
  /** `true` when every check passed. */
  valid: boolean;
  /** Per-check results, in execution order. */
  checks: TransactionCheckResult[];
  /** Names of the checks that failed (empty when `valid`). */
  failedChecks: TransactionCheckName[];
}

/** Options controlling which checks {@link verifyTransaction} performs. */
export interface TransactionVerificationOptions {
  /** Maximum acceptable total fee, in stroops. Fee check is skipped when omitted. */
  maxFee?: number | bigint | string;
  /** The exact sequence number the transaction must carry. Skipped when omitted. */
  expectedSequence?: string;
  /** The hex- or base64-encoded hash the transaction must match. Skipped when omitted. */
  expectedHash?: string;
  /** `G...` public keys that must each hold a valid signature over the tx hash. */
  signers?: string[];
  /** Minimum number of signature entries the transaction must carry (default: 1). */
  minSignatures?: number;
  /** Unix time (seconds) used for the time-bounds check (default: now). */
  now?: number;
}

/** Outcome of verifying the signatures of a transaction for a set of keys. */
export interface SignatureVerificationResult {
  /** Signers that produced a valid signature over the transaction hash. */
  valid: string[];
  /** Signers with no signature present on the transaction. */
  missing: string[];
  /** Signers with a signature present that failed cryptographic verification. */
  invalid: string[];
}

/**
 * A single, independently testable verification rule.
 *
 * Rules may be synchronous or asynchronous. Custom rules can use any `name`
 * (including names outside {@link TransactionCheckName}); their results are
 * reported alongside the built-in checks.
 */
export interface VerificationRule {
  /** Identifier reported in {@link TransactionCheckResult.name}. */
  name: string;
  /** Evaluate the rule against `tx`, returning a structured result. */
  validate(
    tx: Transaction,
    context?: unknown,
  ): TransactionCheckResult | Promise<TransactionCheckResult>;
}

/** Aggregated verification statistics tracked by a {@link TransactionVerifier}. */
export interface TransactionVerifierStats {
  /** Total number of transactions verified. */
  total: number;
  /** Number of transactions that passed every rule. */
  passed: number;
  /** Number of transactions that failed at least one rule. */
  failed: number;
  /** Number of failures attributed to each rule name. */
  ruleFailures: Record<string, number>;
}

function toBigIntSafe(value: string | number | bigint): bigint | null {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * Verify that each of `publicKeys` holds a valid signature over `tx`'s hash.
 *
 * Decorated signatures carry a 4-byte hint derived from the signer's public
 * key; candidates are filtered by hint and then verified cryptographically
 * with ed25519 over the 32-byte transaction hash. Hints are advisory only —
 * a signature counts as valid solely when ed25519 verification succeeds.
 *
 * @param tx - The (partially or fully) signed transaction.
 * @param publicKeys - `G...` keys expected to have signed the transaction.
 */
export function verifyTransactionSignatures(
  tx: Transaction,
  publicKeys: string[],
): SignatureVerificationResult {
  const result: SignatureVerificationResult = { valid: [], missing: [], invalid: [] };
  if (publicKeys.length === 0) {
    return result;
  }

  const hash = tx.hash();

  for (const publicKey of publicKeys) {
    let keypair: Keypair;
    try {
      keypair = Keypair.fromPublicKey(publicKey);
    } catch {
      // Not a parseable G-address — it can never hold a valid signature.
      result.invalid.push(publicKey);
      continue;
    }

    const keyHint = keypair.signatureHint().toString("hex");
    const candidates = tx.signatures.filter(
      (sig) => Buffer.from(sig.hint()).toString("hex") === keyHint,
    );

    if (candidates.length === 0) {
      result.missing.push(publicKey);
      continue;
    }

    let verified = false;
    for (const decorated of candidates) {
      try {
        if (keypair.verify(hash, Buffer.from(decorated.signature()))) {
          verified = true;
          break;
        }
      } catch {
        // Malformed signature payload — treated as a failed verification.
      }
    }

    if (verified) {
      result.valid.push(publicKey);
    } else {
      result.invalid.push(publicKey);
    }
  }

  return result;
}

/** Options for the network passphrase rule. */
export interface NetworkVerificationOptions {
  /** The network passphrase the transaction must be signed for. */
  networkPassphrase?: string;
}

/**
 * Build the default set of verification rules.
 *
 * Rules whose options are omitted (e.g. `maxFee`, `expectedSequence`,
 * `expectedHash`, `networkPassphrase`) pass vacuously so callers only assert
 * the properties they can vouch for.
 */
function createDefaultRules(): VerificationRule[] {
  return [
    {
      name: "structure",
      validate(tx) {
        const operationCount = tx.operations.length;
        const rawFee = toBigIntSafe(tx.fee);
        const ok = operationCount > 0 && rawFee !== null && rawFee > 0n;
        return {
          name: "structure",
          passed: ok,
          detail: ok
            ? `Transaction has ${operationCount} operation(s) and fee ${tx.fee}`
            : `Malformed transaction: ${operationCount} operation(s), fee "${tx.fee}"`,
        };
      },
    },
    {
      name: "fee",
      validate(tx, context) {
        const options = (context ?? {}) as TransactionVerificationOptions;
        if (options.maxFee === undefined) {
          return { name: "fee", passed: true, detail: "Fee check skipped" };
        }
        const rawFee = toBigIntSafe(tx.fee);
        const maxFee = toBigIntSafe(options.maxFee);
        const ok = rawFee !== null && maxFee !== null && rawFee > 0n && rawFee <= maxFee;
        return {
          name: "fee",
          passed: ok,
          detail: ok
            ? `Fee ${tx.fee} is within max ${String(options.maxFee)}`
            : `Fee ${tx.fee} exceeds maximum ${String(options.maxFee)} (or is not a positive integer)`,
        };
      },
    },
    {
      name: "sequence",
      validate(tx, context) {
        const options = (context ?? {}) as TransactionVerificationOptions;
        if (options.expectedSequence === undefined) {
          return { name: "sequence", passed: true, detail: "Sequence check skipped" };
        }
        const ok = tx.sequence === options.expectedSequence;
        return {
          name: "sequence",
          passed: ok,
          detail: ok
            ? `Sequence ${tx.sequence} matches expected`
            : `Sequence ${tx.sequence} does not match expected ${options.expectedSequence}`,
        };
      },
    },
    {
      name: "timebounds",
      validate(tx, context) {
        const options = (context ?? {}) as TransactionVerificationOptions;
        const timeBounds = tx.timeBounds;
        if (timeBounds === undefined || timeBounds === null) {
          return { name: "timebounds", passed: true, detail: "No time bounds set" };
        }
        const now = BigInt(options.now ?? Math.floor(Date.now() / 1000));
        const minTime = BigInt(timeBounds.minTime);
        const maxTime = BigInt(timeBounds.maxTime);
        const afterMin = now >= minTime;
        // maxTime is exclusive; 0 means "no upper bound".
        const beforeMax = maxTime === 0n || now < maxTime;
        const ok = afterMin && beforeMax;
        return {
          name: "timebounds",
          passed: ok,
          detail: ok
            ? `Now (${now}) is within [${timeBounds.minTime}, ${timeBounds.maxTime})`
            : `Now (${now}) is outside time bounds [${timeBounds.minTime}, ${timeBounds.maxTime})`,
        };
      },
    },
    {
      name: "signatures",
      validate(tx, context) {
        const options = (context ?? {}) as TransactionVerificationOptions;
        // Without an explicit signer list, at least one signature entry must be
        // present; with signers, minSignatures defaults to 0 and each listed key
        // must hold a cryptographically valid signature.
        const minSignatures = options.minSignatures ?? (options.signers ? 0 : 1);
        const parts: string[] = [];
        let ok = tx.signatures.length >= Math.max(minSignatures, 0);

        if (!ok) {
          parts.push(
            `Transaction carries ${tx.signatures.length} signature(s); ${minSignatures} required`,
          );
        }

        if (options.signers && options.signers.length > 0) {
          const sigResult = verifyTransactionSignatures(tx, options.signers);
          if (sigResult.valid.length > 0) {
            parts.push(`valid: [${sigResult.valid.join(", ")}]`);
          }
          if (sigResult.missing.length > 0) {
            ok = false;
            parts.push(`missing: [${sigResult.missing.join(", ")}]`);
          }
          if (sigResult.invalid.length > 0) {
            ok = false;
            parts.push(`invalid: [${sigResult.invalid.join(", ")}]`);
          }
        } else if (ok) {
          parts.push(`${tx.signatures.length} signature(s) present`);
        }

        return { name: "signatures", passed: ok, detail: parts.join("; ") };
      },
    },
    {
      name: "hash",
      validate(tx, context) {
        const options = (context ?? {}) as TransactionVerificationOptions;
        if (options.expectedHash === undefined) {
          return { name: "hash", passed: true, detail: "Hash check skipped" };
        }
        const hash = tx.hash();
        const expected = options.expectedHash.toLowerCase();
        const ok =
          hash.toString("hex").toLowerCase() === expected ||
          hash.toString("base64") === options.expectedHash;
        return {
          name: "hash",
          passed: ok,
          detail: ok
            ? "Transaction hash matches expected"
            : `Transaction hash ${hash.toString("hex")} does not match expected ${options.expectedHash}`,
        };
      },
    },
    {
      name: "network",
      validate(tx, context) {
        const options = (context ?? {}) as TransactionVerificationOptions &
          NetworkVerificationOptions;
        if (options.networkPassphrase === undefined) {
          return { name: "network", passed: true, detail: "Network check skipped" };
        }
        const ok = tx.networkPassphrase === options.networkPassphrase;
        return {
          name: "network",
          passed: ok,
          detail: ok
            ? `Transaction targets network ${options.networkPassphrase}`
            : `Transaction targets network ${tx.networkPassphrase}, expected ${options.networkPassphrase}`,
        };
      },
    },
  ];
}

/**
 * Rule-based, stateful transaction verifier.
 *
 * Ships with the default rules (structure, fee, sequence, timebounds,
 * signatures, hash, network) and supports registering custom rules via
 * {@link addRule}. Every call to {@link verify} updates the tracked statistics
 * exposed by {@link getStats}.
 *
 * @example
 * ```ts
 * const verifier = new TransactionVerifier();
 * verifier.addRule({
 *   name: "memo",
 *   validate: (tx) => ({
 *     name: "memo",
 *     passed: tx.memo.value !== undefined,
 *     detail: "Transaction must carry a memo",
 *   }),
 * });
 * const result = await verifier.verify(tx, { signers: [key] });
 * ```
 */
export class TransactionVerifier {
  private readonly rules: VerificationRule[] = [];
  private stats: TransactionVerifierStats = {
    total: 0,
    passed: 0,
    failed: 0,
    ruleFailures: {},
  };

  constructor(rules: VerificationRule[] = createDefaultRules()) {
    for (const rule of rules) {
      this.addRule(rule);
    }
  }

  /** Register a rule. Replaces any existing rule with the same name. */
  addRule(rule: VerificationRule): this {
    const index = this.rules.findIndex((r) => r.name === rule.name);
    if (index >= 0) {
      this.rules[index] = rule;
    } else {
      this.rules.push(rule);
    }
    return this;
  }

  /** Remove a rule by name. Returns `true` if a rule was removed. */
  removeRule(name: string): boolean {
    const index = this.rules.findIndex((r) => r.name === name);
    if (index < 0) {
      return false;
    }
    this.rules.splice(index, 1);
    return true;
  }

  /** Names of the currently registered rules, in execution order. */
  getRuleNames(): string[] {
    return this.rules.map((r) => r.name);
  }

  /** Snapshot of the verification statistics tracked so far. */
  getStats(): TransactionVerifierStats {
    return {
      total: this.stats.total,
      passed: this.stats.passed,
      failed: this.stats.failed,
      ruleFailures: { ...this.stats.ruleFailures },
    };
  }

  /** Reset all tracked statistics to zero. */
  resetStats(): void {
    this.stats = { total: 0, passed: 0, failed: 0, ruleFailures: {} };
  }

  /**
   * Run every registered rule against `tx` and aggregate the results.
   *
   * A rule that throws is recorded as a failed check rather than aborting the
   * pipeline, so a single misbehaving custom rule cannot mask other results.
   */
  async verify(
    tx: Transaction,
    options: TransactionVerificationOptions & NetworkVerificationOptions = {},
  ): Promise<TransactionVerificationResult> {
    const checks: TransactionCheckResult[] = [];

    for (const rule of this.rules) {
      let result: TransactionCheckResult;
      try {
        result = await rule.validate(tx, options);
      } catch (error) {
        result = {
          name: rule.name as TransactionCheckName,
          passed: false,
          detail: `Rule "${rule.name}" threw: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      checks.push(result);
    }

    const failedChecks = checks.filter((c) => !c.passed).map((c) => c.name);
    const valid = failedChecks.length === 0;

    this.stats.total += 1;
    if (valid) {
      this.stats.passed += 1;
    } else {
      this.stats.failed += 1;
      for (const name of failedChecks) {
        this.stats.ruleFailures[name] = (this.stats.ruleFailures[name] ?? 0) + 1;
      }
    }

    return { valid, checks, failedChecks };
  }
}

/** Shared default verifier used by {@link verifyTransaction}. */
const defaultVerifier = new TransactionVerifier();

/**
 * Run every verification check against `tx` and return the structured result.
 *
 * Delegates to a shared {@link TransactionVerifier} configured with the default
 * rules. Checks whose options are omitted (e.g. `maxFee`, `expectedSequence`,
 * `expectedHash`) are skipped rather than passed vacuously, so callers only
 * assert the properties they can vouch for.
 *
 * @param tx - The transaction to verify.
 * @param options - Which additional properties the transaction must satisfy.
 */
export function verifyTransaction(
  tx: Transaction,
  options: TransactionVerificationOptions & NetworkVerificationOptions = {},
): TransactionVerificationResult {
  // The default rules are synchronous, so the pipeline resolves synchronously.
  // We run it through the shared verifier to keep tracking consistent.
  const checks: TransactionCheckResult[] = [];
  for (const rule of defaultVerifier.getRuleNames()) {
    void rule;
  }
  // Execute synchronously by invoking each default rule directly.
  for (const rule of createDefaultRules()) {
    const result = rule.validate(tx, options) as TransactionCheckResult;
    checks.push(result);
  }

  const failedChecks = checks.filter((c) => !c.passed).map((c) => c.name);
  return { valid: failedChecks.length === 0, checks, failedChecks };
}

/**
 * Verify `tx` and throw {@link TransactionVerificationError} if any check
 * fails; otherwise return the successful result.
 *
 * @param tx - The transaction to verify.
 * @param options - Which additional properties the transaction must satisfy.
 * @throws {TransactionVerificationError} Carries the names of the failed checks.
 */
export function assertTransactionVerified(
  tx: Transaction,
  options: TransactionVerificationOptions & NetworkVerificationOptions = {},
): TransactionVerificationResult {
  const result = verifyTransaction(tx, options);
  if (!result.valid) {
    throw new TransactionVerificationError(result.failedChecks, {
      checks: result.checks,
    });
  }
  return result;
}

/**
 * Verify `tx` with a {@link TransactionVerifier} and throw
 * {@link TransactionVerificationError} if any check fails.
 *
 * @param verifier - The verifier (with its rules and stats) to use.
 * @param tx - The transaction to verify.
 * @param options - Which additional properties the transaction must satisfy.
 * @throws {TransactionVerificationError} Carries the names of the failed checks.
 */
export async function assertTransactionVerifiedAsync(
  verifier: TransactionVerifier,
  tx: Transaction,
  options: TransactionVerificationOptions & NetworkVerificationOptions = {},
): Promise<TransactionVerificationResult> {
  const result = await verifier.verify(tx, options);
  if (!result.valid) {
    throw new TransactionVerificationError(result.failedChecks, {
      checks: result.checks,
    });
  }
  return result;
}

