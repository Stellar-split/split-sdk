/**
 * Example: Error recovery strategies, error codes, and pre-submit validation
 *
 * Demonstrates the pieces added by issues #1259–#1262:
 *
 * 1. Validating a Soroban contract address, with caching and verification (#1259)
 * 2. Verifying transaction integrity/authenticity before submission (#1260)
 * 3. Looking up comprehensive error codes and messages (#1261)
 * 4. Mapping errors to recovery strategies and recovering automatically (#1262)
 *
 * Run with: npx tsx examples/error-recovery-example.ts
 */

import {
  // #1259 — contract address validation
  ContractAddressValidator,
  // #1260 — transaction verification
  TransactionVerifier,
  // #1261 — comprehensive error codes
  SdkError,
  SdkErrorCode,
  getErrorByCode,
  getErrorMessage,
  isRetryableErrorCode,
  // #1262 — recovery strategies
  getRecoveryStrategy,
  getRecoveryPlan,
  executeWithRecovery,
} from "@stellar-split/sdk";

// ---------------------------------------------------------------------------
// 1. Contract address validation (#1259)
// ---------------------------------------------------------------------------

const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

console.log("== Contract address validation (#1259) ==");

const validator = new ContractAddressValidator({
  // Optional: verify the contract actually exists on-chain.
  // Left disabled here so the example runs without network access.
  verifyOnChain: false,
  cacheSize: 100,
});

const validation = await validator.validate(CONTRACT_ID);
console.log(`validator.validate(${CONTRACT_ID.slice(0, 12)}...)`);
console.log(`  valid:    ${validation.valid}`); // true
console.log(`  format:   ${validation.format}`); // true — length, prefix, base32
console.log(`  checksum: ${validation.checksum}`); // true — CRC16 verified

// Second call is served from the cache.
const cached = await validator.validate(CONTRACT_ID);
console.log(`  cached:   ${cached.cached}`); // true

const typo = `${CONTRACT_ID.slice(0, 55)}${CONTRACT_ID[55] === "4" ? "5" : "4"}`;
const typoResult = await validator.validate(typo);
console.log(`\nTypo'd checksum: ${typoResult.valid}`); // false
console.log(`  errors: ${typoResult.errors.join("; ")}`);

try {
  await validator.assertValid("not-a-contract");
} catch (err) {
  console.log(`\nvalidator.assertValid threw: ${(err as Error).message}`);
}

// Validation stats are tracked for observability.
console.log(`\nValidation stats:`, validator.getStats());

// ---------------------------------------------------------------------------
// 2. Transaction verification before submit (#1260)
// ---------------------------------------------------------------------------

console.log("\n== Transaction verification (#1260) ==");

// In real usage you would build and sign a transaction with your wallet.
// Here we only show the API surface:
//
//   const verifier = new TransactionVerifier({
//     signers: [walletPublicKey],      // every key must hold a valid signature
//     maxFee: 500_000,                 // refuse to overpay
//     expectedSequence: account.sequenceNumber(), // refuse stale sequences
//     expectedHash: previouslyComputedHash,       // refuse tampered payloads
//   });
//
//   // Custom rules run alongside the built-in checks.
//   verifier.addRule("memo-required", (tx) =>
//     tx.memo ? null : "transaction must include a memo",
//   );
//
//   const result = await verifier.verify(tx);
//   if (!result.valid) {
//     console.warn("Refusing to submit, failed checks:", result.failedChecks);
//   }
//
//   // Or fail fast:
//   await verifier.assertVerified(tx);

console.log("new TransactionVerifier({ signers, maxFee, expectedSequence })");
console.log("checks: structure, fee, sequence, timebounds, signatures, hash");
console.log("addRule(name, fn) registers custom validation rules");
console.log("assertVerified throws TransactionVerificationError on failure");

// ---------------------------------------------------------------------------
// 3. Comprehensive error codes (#1261)
// ---------------------------------------------------------------------------

console.log("\n== Comprehensive error codes (#1261) ==");

const exampleError = new SdkError(
  "The transaction's sequence number is stale",
  SdkErrorCode.SEQUENCE_MISMATCH,
);

console.log(`code:        ${exampleError.code}`);
console.log(`message:     ${getErrorMessage(exampleError.code)}`);
console.log(`retryable:   ${isRetryableErrorCode(exampleError.code)}`);

// Full error reference lookup by code.
const entry = getErrorByCode(SdkErrorCode.SEQUENCE_MISMATCH);
console.log(`\nError reference entry:`);
console.log(`  code:        ${entry.code}`);
console.log(`  name:        ${entry.name}`);
console.log(`  description: ${entry.description}`);
console.log(`  retryable:   ${entry.retryable}`);

// ---------------------------------------------------------------------------
// 4. Recovery strategies (#1262)
// ---------------------------------------------------------------------------

console.log("\n== Recovery strategies (#1262) ==");

const strategy = getRecoveryStrategy(exampleError);
console.log(`action:      ${strategy.action}`); // refresh_and_retry
console.log(`retryable:   ${strategy.retryable}`); // false — rebuild required
console.log(`description: ${strategy.description}`);

const plan = getRecoveryPlan(exampleError);
console.log(`\nFull recovery plan:`);
console.log(`  code:       ${plan.code}`);
console.log(`  action:     ${plan.strategy.action}`);
console.log(`  suggestion: ${plan.suggestion}`);

// Automatic recovery: retry transient failures with the mapped backoff.
console.log("\nAutomatic recovery with executeWithRecovery:");

let attempts = 0;
const flakyGetInvoice = async () => {
  attempts += 1;
  if (attempts < 3) {
    // Simulate a transient network failure the SDK classifies as retryable.
    throw new SdkError("Request timed out", SdkErrorCode.NETWORK_TIMEOUT);
  }
  return { id: "inv-1", status: "Pending" };
};

const invoice = await executeWithRecovery(flakyGetInvoice, {
  // Exponential backoff between attempts.
  backoff: { initialDelayMs: 100, maxDelayMs: 2_000, multiplier: 2, jitter: true },
  maxAttempts: 5,
  // Recovery hooks fire around each retry.
  onRetry: (attempt, s) =>
    console.warn(`  retry ${attempt}: ${s.description}`),
  onRecovered: (attempt) =>
    console.log(`  recovered after ${attempt} attempt(s)`),
});

console.log(`  result after ${attempts} attempts:`, invoice);

// Recovery stats summarize what happened.
console.log(`  recovery stats:`, executeWithRecovery.getStats?.());

// Non-retryable failures are surfaced immediately, with a plan attached.
console.log("\nNon-retryable failures are NOT retried:");
try {
  await executeWithRecovery(async () => {
    throw new SdkError("stale sequence", SdkErrorCode.SEQUENCE_MISMATCH);
  });
} catch (err) {
  const e = err as SdkError;
  const plan = getRecoveryPlan(e);
  console.log(`  caught ${e.code} → action: ${plan.strategy.action}`);
}
