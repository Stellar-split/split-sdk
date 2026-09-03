/**
 * InvoiceCloneabilityValidator (#486)
 *
 * Runs a comprehensive pre-flight check on a source invoice before it is
 * cloned, identifying every field that would produce an invalid clone and
 * providing field-level remediation hints.
 *
 * Checks performed:
 *   1. Invoice status must not be CANCELLED or DISPUTED
 *   2. The cloned deadline would be in the future (ledger time + buffer)
 *   3. All recipient accounts still exist and hold the required trustline
 */

import { rpc as SorobanRpc, Horizon } from "@stellar/stellar-sdk";
import { RecipientBalancePreCheck } from "./RecipientBalancePreCheck.js";
import type { Invoice } from "../types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Per-field report emitted by the validator. */
export interface FieldReport {
  /** Invoice field name that was checked. */
  field: string;
  /** Whether this field would allow a valid clone. */
  valid: boolean;
  /** Human-readable reason when `valid` is false. */
  reason?: string;
  /** Suggested action to make this field valid. */
  suggestedFix?: string;
}

/** Aggregated result of a cloneability check for one invoice. */
export interface CloneabilityReport {
  /** ID of the source invoice that was checked. */
  invoiceId: string;
  /** True when every field check passed. */
  cloneable: boolean;
  /** Per-field results (only failing entries when all pass). */
  fieldReports: FieldReport[];
}

/** Options that tune the cloneability check. */
export interface CloneabilityOptions {
  /**
   * Minimum number of milliseconds the cloned deadline must be in the future
   * relative to the current ledger close time.
   * @default 3_600_000 (1 hour)
   */
  minDeadlineBufferMs?: number;
  /**
   * Horizon API base URL for recipient account lookups.
   * @default "https://horizon.stellar.org"
   */
  horizonUrl?: string;
  /**
   * Soroban RPC server instance already held by the caller. When provided,
   * ledger time is fetched from this server instead of creating a new one.
   */
  rpcServer?: SorobanRpc.Server;
  /**
   * Soroban RPC URL used to fetch the latest ledger when `rpcServer` is not
   * provided.
   */
  rpcUrl?: string;
}

// ---------------------------------------------------------------------------
// Statuses that prevent cloning
// ---------------------------------------------------------------------------

const NON_CLONEABLE_STATUSES = new Set(["Cancelled", "Disputed"]);

// ---------------------------------------------------------------------------
// Ledger-time helper
// ---------------------------------------------------------------------------

/**
 * Fetch the close time of the latest ledger from the Soroban RPC.
 * Returns the current wall-clock time as a fallback when the RPC is
 * unavailable (with a console warning).
 */
async function getLedgerTimeMs(
  server: SorobanRpc.Server | null,
  rpcUrl?: string,
): Promise<number> {
  const srv =
    server ??
    (rpcUrl ? new SorobanRpc.Server(rpcUrl) : null);

  if (!srv) {
    console.warn(
      "[InvoiceCloneabilityValidator] No rpcServer or rpcUrl provided — " +
        "falling back to Date.now() for deadline check.",
    );
    return Date.now();
  }

  try {
    const ledger = await srv.getLatestLedger();
    // Soroban returns `ledger.closeTime` as a Unix timestamp in seconds
    const closeTimeSec =
      (ledger as unknown as { closeTime?: number }).closeTime;
    if (typeof closeTimeSec === "number" && closeTimeSec > 0) {
      return closeTimeSec * 1_000;
    }
  } catch {
    // ignore — fall back below
  }

  return Date.now();
}

// ---------------------------------------------------------------------------
// InvoiceCloneabilityValidator
// ---------------------------------------------------------------------------

/**
 * Validates whether an invoice can be safely cloned.
 *
 * @example
 * ```ts
 * const validator = new InvoiceCloneabilityValidator({
 *   horizonUrl: "https://horizon-testnet.stellar.org",
 *   rpcUrl: "https://soroban-testnet.stellar.org",
 *   minDeadlineBufferMs: 3_600_000,
 * });
 *
 * const report = await validator.validate(invoice);
 * if (!report.cloneable) {
 *   throw new InvoiceNotCloneableError(report);
 * }
 * ```
 */
export class InvoiceCloneabilityValidator {
  private readonly _options: Required<
    Omit<CloneabilityOptions, "rpcServer">
  > & { rpcServer?: SorobanRpc.Server };

  constructor(options: CloneabilityOptions = {}) {
    this._options = {
      minDeadlineBufferMs: options.minDeadlineBufferMs ?? 3_600_000,
      horizonUrl: options.horizonUrl ?? "https://horizon.stellar.org",
      rpcServer: options.rpcServer,
      rpcUrl: options.rpcUrl ?? "",
    };
  }

  /**
   * Run all cloneability checks for `invoice`.
   *
   * @returns `CloneabilityReport` — `cloneable: true` and empty `fieldReports`
   *          when everything is valid; otherwise failing `FieldReport` entries
   *          describe each problem.
   */
  async validate(invoice: Invoice): Promise<CloneabilityReport> {
    const reports: FieldReport[] = [];

    // -------------------------------------------------------------------
    // 1. Status check
    // -------------------------------------------------------------------
    if (NON_CLONEABLE_STATUSES.has(invoice.status)) {
      reports.push({
        field: "status",
        valid: false,
        reason: `Invoice has status "${invoice.status}" which prevents cloning.`,
        suggestedFix: `Only Pending or Released invoices can be cloned. Resolve or create a new invoice instead.`,
      });
    }

    // -------------------------------------------------------------------
    // 2. Deadline check — uses ledger time to avoid local clock skew
    // -------------------------------------------------------------------
    const nowMs = await getLedgerTimeMs(
      this._options.rpcServer ?? null,
      this._options.rpcUrl || undefined,
    );
    const deadlineMs = invoice.deadline * 1_000;
    const minFutureMs = nowMs + this._options.minDeadlineBufferMs;

    if (deadlineMs <= nowMs) {
      reports.push({
        field: "deadline",
        valid: false,
        reason: `Deadline (${new Date(deadlineMs).toISOString()}) is already expired as of the current ledger time (${new Date(nowMs).toISOString()}).`,
        suggestedFix: "Create a new invoice or pass a newDeadline override that is set after the current ledger time.",
      });
    } else if (deadlineMs <= minFutureMs) {
      const shortfallSec = Math.ceil((minFutureMs - deadlineMs) / 1_000);
      reports.push({
        field: "deadline",
        valid: false,
        reason: `Deadline (${new Date(deadlineMs).toISOString()}) is too close to now (buffer: ${this._options.minDeadlineBufferMs}ms). Shortfall: ${shortfallSec}s.`,
        suggestedFix: `Pass a \`newDeadline\` override that is at least ${this._options.minDeadlineBufferMs / 1_000}s in the future when calling cloneInvoice().`,
      });
    }

    // -------------------------------------------------------------------
    // 3. Recipient checks — re-uses RecipientBalancePreCheck
    // -------------------------------------------------------------------
    const recipientAddresses = invoice.recipients.map((r) => r.address);
    if (recipientAddresses.length > 0) {
      // Parse asset code/issuer from token field (format: "CODE:ISSUER" or raw address)
      const tokenParts = invoice.token?.includes(":")
        ? invoice.token.split(":")
        : [];

      const checker = new RecipientBalancePreCheck({
        assetCode: tokenParts[0],
        assetIssuer: tokenParts[1],
        horizonUrl: this._options.horizonUrl,
      });

      const failing = await checker.runAndGetFailing(recipientAddresses);
      for (const result of failing) {
        const failedCheckNames = result.checks
          .filter((c) => !c.passed)
          .map((c) => c.name)
          .join(", ");

        reports.push({
          field: `recipients[${result.recipient}]`,
          valid: false,
          reason: `Recipient ${result.recipient} failed checks: ${failedCheckNames}.`,
          suggestedFix: result.remediations.join(" "),
        });
      }
    }

    const cloneable = reports.length === 0;
    return {
      invoiceId: invoice.id,
      cloneable,
      fieldReports: reports,
    };
  }
}
