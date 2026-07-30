/**
 * Asset balance reconciliation engine.
 *
 * After batch invoice payments, the SDK's internal accounting of sent
 * amounts can drift from on-chain reality due to failed operations, fee
 * deductions, or claimable balance unclaims. This engine compares the
 * SDK's internal payment ledger (an invoice's recorded {@link Payment}
 * entries) against the actual outgoing payments fetched from Horizon and
 * surfaces any discrepancies as typed findings.
 */

import { Horizon } from "@stellar/stellar-sdk";
import type { Payment, ReconciliationFinding, ReconciliationReport } from "./types.js";

/** Inclusive Unix-timestamp (seconds) date range used to scope reconciliation. */
export interface ReconciliationDateRange {
  from: number;
  to: number;
}

export interface ReconciliationEngineOptions {
  /**
   * Discrepancy magnitude (in stroops) attributable to fees alone that is
   * still tagged `severity: 'info'`. Defaults to 100 stroops.
   */
  feeToleranceStroops?: bigint;
  /**
   * Discrepancy magnitude (in stroops) above `feeToleranceStroops` that is
   * tagged `severity: 'warning'` rather than `'critical'`. Defaults to
   * 10x the fee tolerance.
   */
  warningThresholdStroops?: bigint;
}

const DEFAULT_FEE_TOLERANCE_STROOPS = 100n;

/**
 * Compares the SDK's internal payment records against actual on-chain
 * payments fetched from Horizon.
 */
export class ReconciliationEngine {
  private readonly horizonServer: Horizon.Server;
  private readonly payments: Payment[];
  private readonly feeToleranceStroops: bigint;
  private readonly warningThresholdStroops: bigint;

  /**
   * @param horizonUrl - Horizon API base URL used to fetch actual on-chain payments.
   * @param payments   - The SDK's internal payment ledger to reconcile against Horizon.
   * @param options    - Optional severity-classification thresholds.
   */
  constructor(horizonUrl: string, payments: Payment[], options: ReconciliationEngineOptions = {}) {
    this.horizonServer = new Horizon.Server(horizonUrl);
    this.payments = payments;
    this.feeToleranceStroops = options.feeToleranceStroops ?? DEFAULT_FEE_TOLERANCE_STROOPS;
    this.warningThresholdStroops = options.warningThresholdStroops ?? this.feeToleranceStroops * 10n;
  }

  /**
   * Reconcile the internal payment ledger for `accountId` (as payer) and
   * `assetCode` against actual outgoing Horizon payments within `dateRange`.
   *
   * Produces one finding per internal payment record: a payment with no
   * matching on-chain counterpart surfaces as a `'critical'` finding.
   */
  async reconcile(
    accountId: string,
    assetCode: string,
    dateRange: ReconciliationDateRange,
  ): Promise<ReconciliationReport> {
    const expected = this.payments.filter(
      (p) => p.payer === accountId && this.withinRange(p.timestamp, dateRange),
    );

    const actualAmounts = await this.fetchActualOutgoingAmounts(accountId, assetCode, dateRange);

    const findings: ReconciliationFinding[] = expected.map((payment) => {
      const matchedAmount = this.consumeMatch(actualAmounts, payment.amount);
      const discrepancy = payment.amount - matchedAmount;
      return {
        accountId,
        assetCode,
        expectedDelta: payment.amount,
        actualDelta: matchedAmount,
        discrepancy,
        severity: this.classify(discrepancy),
        reason: matchedAmount === 0n ? "No matching on-chain payment found" : undefined,
      };
    });

    return {
      accountId,
      assetCode,
      dateRange,
      findings,
      isBalanced: findings.every((f) => f.discrepancy === 0n),
    };
  }

  private withinRange(timestamp: number | undefined, range: ReconciliationDateRange): boolean {
    return timestamp !== undefined && timestamp >= range.from && timestamp <= range.to;
  }

  private classify(discrepancy: bigint): ReconciliationFinding["severity"] {
    const abs = discrepancy < 0n ? -discrepancy : discrepancy;
    if (abs === 0n || abs <= this.feeToleranceStroops) return "info";
    if (abs <= this.warningThresholdStroops) return "warning";
    return "critical";
  }

  /**
   * Removes and returns the first matching amount from `pool` (exact match),
   * or `0n` when no on-chain payment matches — used to avoid double-counting
   * the same on-chain payment against multiple internal records.
   */
  private consumeMatch(pool: bigint[], amount: bigint): bigint {
    const index = pool.indexOf(amount);
    if (index === -1) return 0n;
    pool.splice(index, 1);
    return amount;
  }

  private async fetchActualOutgoingAmounts(
    accountId: string,
    assetCode: string,
    dateRange: ReconciliationDateRange,
  ): Promise<bigint[]> {
    const page = await this.horizonServer.payments().forAccount(accountId).limit(200).call();

    return page.records
      .filter((record): record is Horizon.ServerApi.PaymentOperationRecord => record.type === "payment")
      .filter((record) => record.from === accountId)
      .filter((record) => this.matchesAsset(record, assetCode))
      .filter((record) => {
        const createdAtSeconds = Math.floor(new Date(record.created_at).getTime() / 1000);
        return this.withinRange(createdAtSeconds, dateRange);
      })
      .map((record) => xlmStringToStroops(record.amount));
  }

  private matchesAsset(record: Horizon.ServerApi.PaymentOperationRecord, assetCode: string): boolean {
    if (assetCode === "native") return record.asset_type === "native";
    return record.asset_type !== "native" && record.asset_code === assetCode;
  }
}

/** Convert a Horizon balance/amount string ("1.0000000") to stroops (bigint). */
function xlmStringToStroops(value: string): bigint {
  const [whole = "0", frac = ""] = value.split(".");
  return BigInt(whole) * 10_000_000n + BigInt(frac.padEnd(7, "0").slice(0, 7));
}
