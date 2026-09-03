import { rpc as SorobanRpc, Horizon } from "@stellar/stellar-sdk";
import { inspectFlags } from "./accountFlagsInspector.js";
import type { AccountFlagSet } from "./types.js";
import { withTimeout } from "./timeout.js";
import { PreflightError } from "./errors.js";

export type PayerReadinessReason =
  | "account_not_found"
  | "insufficient_balance"
  | "no_trustline";

export interface PayerReadinessResult {
  ready: boolean;
  reason?: PayerReadinessReason;
}

// ---------------------------------------------------------------------------
// Invoice Expiry Check
// ---------------------------------------------------------------------------

/** Reason an invoice expiry check failed. */
export type InvoiceExpiryReason = "expired" | "expires_within_timebounds";

/** Result of the invoice expiry preflight check. */
export interface InvoiceExpiryResult {
  /** Whether the invoice is still valid for payments. */
  valid: boolean;
  /** Reason for invalidity, if any. */
  reason?: InvoiceExpiryReason;
  /** Unix timestamp (seconds) when the invoice expires. */
  expiresAt: number;
  /** Remaining seconds until expiry (0 or negative if expired). */
  secondsRemaining: number;
}

import { PaymentExpiredError } from "./errors.js";

/**
 * Check whether an invoice has expired and should reject a payment submission.
 *
 * When the invoice has expired, throws {@link PaymentExpiredError}.
 * When it is still valid, returns the remaining time in seconds — ready to
 * be passed to {@link TransactionBuilder.setTimeout} as the transaction
 * `timeBounds.maxTime`.
 *
 * @param expiresAt - Unix timestamp (seconds) when the invoice expires.
 * @param invoiceId - The invoice ID for error messaging.
 * @returns Expiry result with remaining seconds for timebounds.
 *
 * @throws {PaymentExpiredError} When the invoice has already expired.
 */
export function checkInvoiceExpiry(
  expiresAt: number,
  invoiceId: string,
): InvoiceExpiryResult {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const secondsRemaining = expiresAt - nowSeconds;
  const expired = secondsRemaining <= 0;

  if (expired) {
    throw new PaymentExpiredError(invoiceId, expiresAt);
  }

  // If the remaining time is very short (< 30s), warn but still allow
  if (secondsRemaining < 30) {
    return {
      valid: true,
      reason: "expires_within_timebounds",
      expiresAt,
      secondsRemaining,
    };
  }

  return {
    valid: true,
    expiresAt,
    secondsRemaining,
  };
}

// ---------------------------------------------------------------------------
// Sponsor Reserve Preflight Check
// ---------------------------------------------------------------------------

/** Minimum XLM balance an account must retain (2 × BASE_RESERVE = 1 XLM). */
const SPONSOR_MIN_BALANCE_STROOPS = 10_000_000n;

/** One base reserve in stroops (0.5 XLM). */
const BASE_RESERVE_STROOPS = 5_000_000n;

/**
 * Convert a Horizon balance string ("1.0000000") to stroops (bigint).
 */
function xlmStringToStroops(xlm: string): bigint {
  const [whole = "0", frac = ""] = xlm.split(".");
  return BigInt(whole) * 10_000_000n + BigInt(frac.padEnd(7, "0").slice(0, 7));
}

/** Result of a sponsor reserve check. */
export interface SponsorReserveCheck {
  sufficient: boolean;
  availableStroops: bigint;
  requiredStroops: bigint;
  shortfallStroops: bigint;
}

import { InsufficientSponsorReserveError } from "./errors.js";

/**
 * Pre-submission check: verify the sponsoring account has enough XLM reserve
 * to cover the new ledger entries it will sponsor.
 *
 * @param sponsorAddress - Stellar address of the sponsoring account.
 * @param newEntryCount  - Number of new ledger entries the sponsor will cover.
 * @param horizonUrl     - Horizon API base URL for account lookups.
 * @param throwOnInsufficient - When true (default), throws on insufficient reserve.
 *
 * @returns Reserve check result.
 * @throws {InsufficientSponsorReserveError} When reserve is insufficient and throwOnInsufficient is true.
 */
export async function checkSponsorReserve(
  sponsorAddress: string,
  newEntryCount: number,
  horizonUrl: string,
  throwOnInsufficient: boolean = true,
): Promise<SponsorReserveCheck> {
  const horizonServer = new Horizon.Server(horizonUrl);
  const sponsorRecord = await horizonServer.loadAccount(sponsorAddress);

  const numSponsored = sponsorRecord.num_sponsored;
  const nativeLine = sponsorRecord.balances.find(
    (b) => b.asset_type === "native",
  );
  const balanceStroops = nativeLine
    ? xlmStringToStroops(nativeLine.balance)
    : 0n;

  // Available for sponsoring = balance - minimum account reserve - current sponsorship reserve
  const committedReserve =
    SPONSOR_MIN_BALANCE_STROOPS + BASE_RESERVE_STROOPS * BigInt(numSponsored);
  const availableStroops =
    balanceStroops > committedReserve ? balanceStroops - committedReserve : 0n;

  const requiredStroops = BASE_RESERVE_STROOPS * BigInt(newEntryCount);
  const sufficient = availableStroops >= requiredStroops;

  if (!sufficient && throwOnInsufficient) {
    throw new InsufficientSponsorReserveError(
      sponsorAddress,
      availableStroops,
      requiredStroops,
      newEntryCount,
    );
  }

  return {
    sufficient,
    availableStroops,
    requiredStroops,
    shortfallStroops: sufficient ? 0n : requiredStroops - availableStroops,
  };
}

// ---------------------------------------------------------------------------
// Recipient Flags Preflight Check
// ---------------------------------------------------------------------------

/** Result of checking a recipient's account flags against an intended operation. */
export interface RecipientFlagsCheck {
  /** `false` when the recipient's flags make `operation` impossible without prior authorization. */
  compatible: boolean;
  /** The recipient's decoded AUTH_* flags. */
  flags: AccountFlagSet;
}

/**
 * Preflight check: inspect a recipient's AUTH_* flags and flag when they are
 * incompatible with the intended operation (e.g. AUTH_REQUIRED blocking a
 * trustline creation or payment without prior issuer authorization).
 *
 * @param accountId  - Stellar address of the recipient to inspect.
 * @param horizonUrl - Horizon API base URL used to load the account.
 * @param operation  - The operation the caller intends to perform (e.g. "payment").
 */
export async function checkRecipientFlags(
  accountId: string,
  horizonUrl: string,
  operation: string,
): Promise<RecipientFlagsCheck> {
  const flags = await inspectFlags(accountId, horizonUrl);
  return { compatible: flags.isCompatibleWith(operation), flags };
}

// ---------------------------------------------------------------------------
// Payer Readiness Check (existing)
// ---------------------------------------------------------------------------

/**
 * Checks whether a payer account is ready to fund an invoice.
 *
 * Verifies the account exists on-chain, holds a trustline for the required
 * token, and has sufficient balance to cover the required amount.
 *
 * @param server         - Soroban RPC server instance.
 * @param address        - Stellar address of the payer.
 * @param requiredAmount - Amount needed in the token's base unit (as a bigint of stroops).
 * @param token          - Token contract address (or "native" for XLM).
 * @returns Readiness result with an optional failure reason.
 */
export async function checkPayerReadiness(
  server: SorobanRpc.Server,
  address: string,
  requiredAmount: bigint,
  token: string,
): Promise<PayerReadinessResult> {
  let account: Awaited<ReturnType<SorobanRpc.Server["getAccount"]>>;
  try {
    account = await server.getAccount(address);
  } catch {
    return { ready: false, reason: "account_not_found" };
  }

  const isNative = token === "native";
  const balances = ((account as unknown as Record<string, unknown>).balances ?? []) as Array<{
    balance: string;
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
    liquidity_pool_id?: string;
  }>;

  if (isNative) {
    const nativeBalance = balances.find((b) => b.asset_type === "native");
    if (!nativeBalance) {
      return { ready: false, reason: "no_trustline" };
    }
    const balanceStroops = BigInt(Math.round(parseFloat(nativeBalance.balance) * 1_000_000_0));
    if (balanceStroops < requiredAmount) {
      return { ready: false, reason: "insufficient_balance" };
    }
    return { ready: true };
  }

  // For non-native tokens, find a balance entry matching the contract/issuer address.
  // Trustline is identified by asset_issuer matching the token address.
  const tokenBalance = balances.find(
    (b) =>
      b.asset_type !== "native" &&
      b.asset_type !== "liquidity_pool_shares" &&
      b.asset_issuer === token,
  );

  if (!tokenBalance) {
    return { ready: false, reason: "no_trustline" };
  }

  const balanceUnits = BigInt(Math.round(parseFloat(tokenBalance.balance) * 1_000_000_0));
  if (balanceUnits < requiredAmount) {
    return { ready: false, reason: "insufficient_balance" };
  }

  return { ready: true };
}

// ---------------------------------------------------------------------------
// Account Freeze / Lock Preflight Check
// ---------------------------------------------------------------------------

/** Per-recipient lock state report, keyed by recipient address. */
export interface RecipientLockCheckResult {
  allUnlocked: boolean;
  states: Record<string, AccountLockState>;
}

/**
 * Pre-submission check: verify none of the payment recipients are frozen or
 * permanently locked out of authorization for `asset`.
 *
 * Calls {@link detectLockState} for each recipient. Throws on the first
 * frozen or locked account found so callers fail fast before building a
 * transaction that would otherwise be rejected on-chain.
 *
 * @param server     - Horizon server instance.
 * @param recipients - Recipient addresses to check.
 * @param asset      - Asset being sent.
 *
 * @throws {AccountFrozenError} When a recipient's trustline has been frozen by the issuer.
 * @throws {AccountLockedError} When a recipient can never be authorized again for the asset.
 */
export async function checkRecipientsUnlocked(
  server: Horizon.Server,
  recipients: string[],
  asset: Asset,
): Promise<RecipientLockCheckResult> {
  const states: Record<string, AccountLockState> = {};

  for (const recipient of recipients) {
    const state = await detectLockState(server, recipient, asset);
    states[recipient] = state;
    if (state.isFrozen) {
      throw new AccountFrozenError(recipient, asset.getCode());
    }
    if (state.isLocked) {
      throw new AccountLockedError(recipient, asset.getCode());
    }
  }

  return { allUnlocked: true, states };
}

// ---------------------------------------------------------------------------
// Trustline Auth Requirement Check
// ---------------------------------------------------------------------------

/** Result of checking whether an asset issuer requires authorization. */
export interface TrustlineAuthRequirementResult {
  authRequired: boolean;
}

/**
 * Preflight check: detect whether the issuer's account has AUTH_REQUIRED set,
 * meaning each trustline must be explicitly approved before payments can flow.
 *
 * @param server - Horizon server instance.
 * @param issuer - Stellar address of the asset issuer.
 */
export async function checkTrustlineAuthRequirement(
  server: Horizon.Server,
  issuer: string,
): Promise<TrustlineAuthRequirementResult> {
  const account = await server.loadAccount(issuer);
  const authRequired = (account as unknown as { flags: { auth_required: boolean } }).flags.auth_required === true;
  return { authRequired };
}

// ---------------------------------------------------------------------------
// RPC Endpoint Reachability Check
// ---------------------------------------------------------------------------

/** Default timeout (ms) for the RPC reachability probe. */
const DEFAULT_PREFLIGHT_TIMEOUT_MS = 3_000;

/** Options for {@link runPreflight}. */
export interface RunPreflightOptions {
  /** RPC endpoint URL to probe for reachability. */
  rpcUrl: string;
  /** Probe timeout in milliseconds. Defaults to 3000. */
  timeoutMs?: number;
  /**
   * `fetch` implementation to use for the probe. Defaults to the global
   * `fetch`. Provided mainly for testing and non-standard runtimes.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Verify the configured RPC endpoint is reachable before the SDK attempts
 * contract calls, surfacing network problems with a clear error rather than a
 * cryptic downstream timeout.
 *
 * Performs a lightweight HTTP `HEAD` request against `rpcUrl`. Any HTTP
 * response (including 4xx / 405) counts as reachable — this checks
 * connectivity, not method support. A connection failure, DNS error, or a
 * probe that exceeds `timeoutMs` throws a {@link PreflightError} carrying the
 * URL and the underlying reason.
 *
 * @throws {PreflightError} When the endpoint cannot be reached.
 */
export async function runPreflight(options: RunPreflightOptions): Promise<void> {
  const { rpcUrl } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (typeof fetchImpl !== "function") {
    throw new PreflightError(rpcUrl, "no fetch implementation available in this runtime");
  }

  const result = await withTimeout(
    (signal) => fetchImpl(rpcUrl, { method: "HEAD", signal }),
    timeoutMs,
    "runPreflight",
  );

  if (!result.ok) {
    if (result.reason === "timeout") {
      throw new PreflightError(rpcUrl, `endpoint did not respond within ${timeoutMs}ms`);
    }
    const reason = result.error instanceof Error ? result.error.message : String(result.error);
    throw new PreflightError(rpcUrl, reason);
  }
}
