/**
 * SubentryCapacityGuard — pre-flight subentry slot check (Issue #591)
 *
 * Stellar accounts have a hard protocol limit on the number of subentries
 * (trustlines, offers, data entries, and signers) they can hold, gated by the
 * account's minimum balance reserve. This module exposes
 * `checkSubentryCapacity` which pre-checks whether an account has enough free
 * slots before any operation that would increase its subentry count.
 *
 * Reserve formula (per the Stellar protocol):
 *   minimum_balance = (2 + numSubentries + numSponsoring − numSponsored) × BASE_RESERVE
 *
 * Available free slots are back-calculated from the account's free XLM balance
 * (balance minus locked reserve).
 */

import { Horizon } from "@stellar/stellar-sdk";
import { StellarSplitError } from "../errors.js";
import type { SubentryCapacityResult } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** One base reserve in stroops (0.5 XLM). */
const BASE_RESERVE_STROOPS = 5_000_000n;

/** One XLM in stroops. */
const XLM_STROOPS = 10_000_000n;

// ---------------------------------------------------------------------------
// SubentryCapacityGuardError
// ---------------------------------------------------------------------------

/**
 * Thrown when an account's subentry capacity is insufficient to accommodate
 * the requested number of new slots.
 */
export class SubentryCapacityGuardError extends StellarSplitError {
  /** Stellar address of the account that lacks capacity. */
  readonly accountId: string;
  /** Number of additional stroops of XLM required to satisfy the reserve. */
  readonly additionalReserveNeededStroops: bigint;
  /** Human-readable XLM amount needed (7 decimal places). */
  readonly additionalReserveNeededXlm: string;
  /** Full capacity result snapshot. */
  readonly capacityResult: SubentryCapacityResult;

  constructor(
    accountId: string,
    additionalReserveNeededStroops: bigint,
    capacityResult: SubentryCapacityResult,
  ) {
    const xlmNeeded = stroopsToXlm(additionalReserveNeededStroops);
    super(
      `Account ${accountId} cannot accommodate ${capacityResult.limit - capacityResult.available} ` +
        `additional subentry slot(s). ` +
        `Requires ${xlmNeeded} XLM (${additionalReserveNeededStroops} stroops) of additional reserve.`,
      "SUBENTRY_CAPACITY_EXCEEDED",
      {
        accountId,
        additionalReserveNeededStroops: additionalReserveNeededStroops.toString(),
        additionalReserveNeededXlm: xlmNeeded,
        used: capacityResult.used,
        available: capacityResult.available,
        limit: capacityResult.limit,
      },
    );
    this.name = "SubentryCapacityGuardError";
    this.accountId = accountId;
    this.additionalReserveNeededStroops = additionalReserveNeededStroops;
    this.additionalReserveNeededXlm = xlmNeeded;
    this.capacityResult = capacityResult;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a Horizon balance string ("1.0000000") to stroops (bigint).
 */
function xlmStringToStroops(xlm: string): bigint {
  const [whole = "0", frac = ""] = xlm.split(".");
  return (
    BigInt(whole) * XLM_STROOPS +
    BigInt(frac.padEnd(7, "0").slice(0, 7))
  );
}

/**
 * Format a stroops bigint as an XLM string with 7 decimal places.
 */
function stroopsToXlm(stroops: bigint): string {
  const whole = stroops / XLM_STROOPS;
  const frac = stroops % XLM_STROOPS;
  return `${whole}.${frac.toString().padStart(7, "0")}`;
}

// ---------------------------------------------------------------------------
// checkSubentryCapacity
// ---------------------------------------------------------------------------

/**
 * Pre-flight check: verify a Stellar account has enough free subentry slots to
 * accommodate `requiredSlots` additional entries (trustlines, data entries,
 * signers, offers).
 *
 * Loads the account via Horizon and applies the protocol reserve formula:
 *   freeBalance = balance − (2 + numSubentries + numSponsoring − numSponsored) × BASE_RESERVE
 *   freeSlots   = freeBalance ÷ BASE_RESERVE   (integer division)
 *
 * @param accountId    - Stellar G… address of the account to check.
 * @param requiredSlots - Number of new subentry slots the caller needs.
 * @param horizonUrl   - Horizon API base URL (e.g. "https://horizon.stellar.org").
 * @returns {@link SubentryCapacityResult} with `used`, `available`, `limit`, and `canAccommodate`.
 * @throws {SubentryCapacityGuardError} When the account cannot accommodate `requiredSlots`.
 */
export async function checkSubentryCapacity(
  accountId: string,
  requiredSlots: number,
  horizonUrl: string,
): Promise<SubentryCapacityResult> {
  const server = new Horizon.Server(horizonUrl, {
    allowHttp: horizonUrl.startsWith("http://"),
  });
  const account = await server.loadAccount(accountId);

  // Pull the three subentry-related fields from the account record.
  // Horizon always returns these; fall back to 0 for safety.
  const numSubentries: number = account.subentry_count ?? 0;
  const numSponsoring: number = (account as unknown as { num_sponsoring?: number }).num_sponsoring ?? 0;
  const numSponsored: number = (account as unknown as { num_sponsored?: number }).num_sponsored ?? 0;

  // Effective subentries that consume reserve.
  const effectiveSubentries = numSubentries + numSponsoring - numSponsored;

  // Locked reserve in stroops:  (2 + effectiveSubentries) × BASE_RESERVE
  const lockedReserve = BASE_RESERVE_STROOPS * BigInt(2 + effectiveSubentries);

  // Current XLM balance in stroops.
  const nativeLine = account.balances.find((b) => b.asset_type === "native");
  const balanceStroops = nativeLine
    ? xlmStringToStroops(nativeLine.balance)
    : 0n;

  // Free balance available for new subentries.
  const freeBalanceStroops =
    balanceStroops > lockedReserve ? balanceStroops - lockedReserve : 0n;

  // How many additional subentry slots the free balance can support.
  const availableSlots = Number(freeBalanceStroops / BASE_RESERVE_STROOPS);

  const result: SubentryCapacityResult = {
    used: numSubentries,
    available: availableSlots,
    limit: numSubentries + availableSlots,
    canAccommodate: availableSlots >= requiredSlots,
  };

  if (!result.canAccommodate) {
    const shortfallSlots = requiredSlots - availableSlots;
    const additionalReserveNeededStroops = BASE_RESERVE_STROOPS * BigInt(shortfallSlots);
    throw new SubentryCapacityGuardError(
      accountId,
      additionalReserveNeededStroops,
      result,
    );
  }

  return result;
}
