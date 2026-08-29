/**
 * RecipientBalancePreCheck
 *
 * Validates each proposed invoice recipient's on-chain readiness before the
 * `createInvoice` call is committed. Checks:
 *   1. Account exists on the network
 *   2. The required trustline is present
 *   3. The account holds sufficient XLM to cover its minimum reserve
 *   4. The account has not been merged (secondary guard via account existence)
 */

import { Horizon } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Name of each individual check run against a recipient account. */
export type CheckName =
  | "account_exists"
  | "trustline_present"
  | "minimum_reserve"
  | "not_merged";

/** Result of one individual check. */
export interface CheckItem {
  name: CheckName;
  passed: boolean;
  /** Human-readable description of what was found (or why it failed). */
  detail: string;
}

/** Aggregated per-recipient pre-check result. */
export interface PreCheckResult {
  /** Stellar address of the recipient. */
  recipient: string;
  /** Individual check outcomes. */
  checks: CheckItem[];
  /** True only when every check passed. */
  passed: boolean;
  /** Human-readable remediation hints for every failing check. */
  remediations: string[];
}

/** Parameters controlling the pre-check run. */
export interface RecipientPreCheckOptions {
  /**
   * Asset code to verify a trustline for (e.g. "USDC").
   * Omit for native XLM — trustline check is skipped.
   */
  assetCode?: string;
  /**
   * Asset issuer address matching the trustline.
   * Required when `assetCode` is provided.
   */
  assetIssuer?: string;
  /**
   * Horizon API base URL.  Defaults to the Stellar mainnet Horizon.
   * Override in tests / for testnet usage.
   */
  horizonUrl?: string;
  /**
   * XLM amount threshold above the minimum reserve.
   * When native balance exceeds minimumReserveXlm + skipThresholdXlm,
   * the minimum_reserve check passes immediately without detailed validation.
   * Defaults to 10 XLM.
   */
  skipThresholdXlm?: number;
}

// ---------------------------------------------------------------------------
// Minimum-reserve calculation
// ---------------------------------------------------------------------------

/** 1 XLM in stroops. */
const XLM_STROOPS = 10_000_000n;

/**
 * Minimum reserve in XLM for an account with `subentries` sub-entries.
 * Formula: (2 + subentryCount) × 0.5 XLM
 */
function minimumReserveXlm(subentryCount: number): number {
  return (2 + subentryCount) * 0.5;
}

// ---------------------------------------------------------------------------
// Core check logic
// ---------------------------------------------------------------------------

/**
 * Run all pre-flight checks for a single recipient.
 *
 * @param server    - Horizon.Server instance to use for account lookups.
 * @param recipient - Stellar G… address of the recipient.
 * @param options   - Asset code/issuer for trustline verification.
 */
async function checkRecipient(
  server: Horizon.Server,
  recipient: string,
  options: RecipientPreCheckOptions,
): Promise<PreCheckResult> {
  const checks: CheckItem[] = [];
  const remediations: string[] = [];

  // -------------------------------------------------------------------
  // 1. Account existence
  // -------------------------------------------------------------------
  let account: Awaited<ReturnType<Horizon.Server["loadAccount"]>> | null = null;

  try {
    account = await server.loadAccount(recipient);
    checks.push({
      name: "account_exists",
      passed: true,
      detail: `Account ${recipient} exists on the network.`,
    });
  } catch {
    checks.push({
      name: "account_exists",
      passed: false,
      detail: `Account ${recipient} was not found on the network.`,
    });
    remediations.push(
      `Fund account ${recipient} with at least 1 XLM to create it on the Stellar network.`,
    );
    // Cannot run further checks without an account.
    return { recipient, checks, passed: false, remediations };
  }

  // -------------------------------------------------------------------
  // 2. Not merged (account exists with a valid sequence number)
  //    A merged account has been removed from the ledger; we check its
  //    sequence number as a secondary guard.  The loadAccount above would
  //    have already failed for merged accounts, but we keep the explicit
  //    check for documentation clarity and future-proofing.
  // -------------------------------------------------------------------
  const sequenceNum = BigInt(account.sequenceNumber());
  if (sequenceNum >= 0n) {
    checks.push({
      name: "not_merged",
      passed: true,
      detail: `Account ${recipient} has not been merged (sequence: ${sequenceNum}).`,
    });
  } else {
    checks.push({
      name: "not_merged",
      passed: false,
      detail: `Account ${recipient} appears to have been merged (invalid sequence).`,
    });
    remediations.push(
      `Re-create recipient account ${recipient} — it appears to have been merged into another account.`,
    );
  }

  // -------------------------------------------------------------------
  // 3. Trustline present (only when assetCode + assetIssuer are given)
  // -------------------------------------------------------------------
  if (options.assetCode && options.assetIssuer) {
    const { assetCode, assetIssuer } = options;
    const hasTrustline = account.balances.some(
      (b) =>
        b.asset_type !== "native" &&
        b.asset_type !== "liquidity_pool_shares" &&
        (b as Horizon.HorizonApi.BalanceLineAsset).asset_code === assetCode &&
        (b as Horizon.HorizonApi.BalanceLineAsset).asset_issuer === assetIssuer,
    );

    if (hasTrustline) {
      checks.push({
        name: "trustline_present",
        passed: true,
        detail: `Trustline for ${assetCode}:${assetIssuer} is present.`,
      });
    } else {
      checks.push({
        name: "trustline_present",
        passed: false,
        detail: `No trustline found for ${assetCode}:${assetIssuer}.`,
      });
      remediations.push(
        `Add a trustline for ${assetCode} (issuer: ${assetIssuer}) to account ${recipient} before the invoice is paid out.`,
      );
    }
  }

  // -------------------------------------------------------------------
  // 4. Minimum reserve
  //    native balance - (2 + subentries) × 0.5 XLM ≥ 0
  // -------------------------------------------------------------------
  const nativeBalance = account.balances.find(
    (b) => b.asset_type === "native",
  );

  if (nativeBalance) {
    const balanceXlm = parseFloat(nativeBalance.balance);
    const reserveXlm = minimumReserveXlm(account.subentry_count);
    const skipThreshold = options.skipThresholdXlm ?? 10;

    // Fast-path: if balance is well above reserve, skip detailed validation
    if (balanceXlm >= reserveXlm + skipThreshold) {
      console.debug(
        `[RecipientBalancePreCheck] Fast-path skip for ${recipient}: balance ${balanceXlm.toFixed(7)} XLM >= reserve ${reserveXlm.toFixed(7)} XLM + threshold ${skipThreshold} XLM`,
      );
      checks.push({
        name: "minimum_reserve",
        passed: true,
        detail: `XLM balance (${balanceXlm.toFixed(7)} XLM) satisfies minimum reserve (${reserveXlm.toFixed(7)} XLM).`,
      });
    } else {
      const shortfallXlm = reserveXlm - balanceXlm;

      if (shortfallXlm <= 0) {
        checks.push({
          name: "minimum_reserve",
          passed: true,
          detail: `XLM balance (${balanceXlm.toFixed(7)} XLM) satisfies minimum reserve (${reserveXlm.toFixed(7)} XLM).`,
        });
      } else {
        const shortfallStroops = BigInt(Math.ceil(shortfallXlm * Number(XLM_STROOPS)));
        checks.push({
          name: "minimum_reserve",
          passed: false,
          detail: `XLM balance (${balanceXlm.toFixed(7)} XLM) is below the minimum reserve (${reserveXlm.toFixed(7)} XLM). Shortfall: ${shortfallXlm.toFixed(7)} XLM (${shortfallStroops} stroops).`,
        });
        remediations.push(
          `Send at least ${shortfallXlm.toFixed(7)} XLM (${shortfallStroops} stroops) to account ${recipient} to satisfy the minimum reserve requirement.`,
        );
      }
    }
  } else {
    // Should not happen for a funded account, but guard defensively.
    checks.push({
      name: "minimum_reserve",
      passed: false,
      detail: `No native XLM balance entry found for account ${recipient}.`,
    });
    remediations.push(
      `Ensure account ${recipient} holds native XLM to cover the minimum reserve.`,
    );
  }

  const passed = checks.every((c) => c.passed);
  return { recipient, checks, passed, remediations };
}

// ---------------------------------------------------------------------------
// RecipientBalancePreCheck class
// ---------------------------------------------------------------------------

/**
 * Runs balance / trustline pre-flight checks for a list of recipient
 * addresses before an invoice is created.
 *
 * @example
 * ```ts
 * const checker = new RecipientBalancePreCheck({
 *   assetCode: "USDC",
 *   assetIssuer: "GA5ZSEJY...",
 *   horizonUrl: "https://horizon-testnet.stellar.org",
 * });
 *
 * const results = await checker.run(["GABC...", "GDEF..."]);
 * const failing = results.filter(r => !r.passed);
 * ```
 */
export class RecipientBalancePreCheck {
  private readonly _server: Horizon.Server;
  private readonly _options: RecipientPreCheckOptions;

  constructor(options: RecipientPreCheckOptions = {}) {
    this._options = options;
    this._server = new Horizon.Server(
      options.horizonUrl ?? "https://horizon.stellar.org",
    );
  }

  /**
   * Run checks for all provided recipient addresses in parallel.
   *
   * @param recipients - Array of Stellar G… addresses.
   * @returns Array of `PreCheckResult`, one per recipient, in the same order.
   */
  async run(recipients: string[]): Promise<PreCheckResult[]> {
    return Promise.all(
      recipients.map((r) => checkRecipient(this._server, r, this._options)),
    );
  }

  /**
   * Convenience helper: run checks and return only the failing results.
   */
  async runAndGetFailing(recipients: string[]): Promise<PreCheckResult[]> {
    const results = await this.run(recipients);
    return results.filter((r) => !r.passed);
  }
}
