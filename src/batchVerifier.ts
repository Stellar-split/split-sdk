import { EventEmitter } from 'events';
import type { Invoice, BatchPayment } from "./types.js";

export interface PortfolioScenario {
  id: string;
  name?: string;
  initialValue: number;
  returns: number[];
  weights?: number[];
}

export interface ScenarioResult {
  id: string;
  name?: string;
  success: boolean;
  finalValue?: number;
  totalReturn?: number;
  error?: string;
}

export interface BatchSimulationSummary {
  total: number;
  succeeded: number;
  failed: number;
  results: ScenarioResult[];
  aggregateFinalValue: number;
  aggregateReturn: number;
}

export interface BatchSimulationOptions {
  /** Continue running remaining scenarios when one fails. Defaults to true. */
  continueOnError?: boolean;
  /** Optional per-scenario simulator. Defaults to compounding returns. */
  simulate?: (scenario: PortfolioScenario) => ScenarioResult;
}

/**
 * Simulates a single portfolio scenario by compounding its periodic returns.
 */
export function simulateScenario(scenario: PortfolioScenario): ScenarioResult {
  const { id, name, initialValue, returns } = scenario;

  if (typeof initialValue !== 'number' || !isFinite(initialValue)) {
    return { id, name, success: false, error: 'initialValue must be a finite number' };
  }
  if (!Array.isArray(returns)) {
    return { id, name, success: false, error: 'returns must be an array' };
  }

  let value = initialValue;
  for (let i = 0; i < returns.length; i++) {
    const r = returns[i];
    if (typeof r !== 'number' || !isFinite(r)) {
      return { id, name, success: false, error: `returns[${i}] must be a finite number` };
    }
    value *= 1 + r;
  }

  const totalReturn = initialValue === 0 ? 0 : (value - initialValue) / initialValue;
  return { id, name, success: true, finalValue: value, totalReturn };
}

/**
 * Runs a batch of portfolio scenarios and aggregates the results.
 * Emits: 'batch:start', 'scenario:start', 'scenario:complete',
 * 'scenario:error', 'batch:complete', 'batch:error'.
 */
export class BatchVerifier extends EventEmitter {
  private readonly options: Required<Pick<BatchSimulationOptions, 'continueOnError'>> &
    Pick<BatchSimulationOptions, 'simulate'>;

  constructor(options: BatchSimulationOptions = {}) {
    super();
    this.options = {
      continueOnError: options.continueOnError !== false,
      simulate: options.simulate,
    };
  }

  /**
   * Simulates all provided scenarios in a single batch.
   */
  run(scenarios: PortfolioScenario[]): BatchSimulationSummary {
    if (!Array.isArray(scenarios)) {
      const error = new Error('scenarios must be an array');
      this.emit('batch:error', error);
      throw error;
    }

    this.emit('batch:start', { total: scenarios.length });

    const results: ScenarioResult[] = [];
    const simulate = this.options.simulate ?? simulateScenario;

    for (const scenario of scenarios) {
      this.emit('scenario:start', scenario);
      let result: ScenarioResult;
      try {
        result = simulate(scenario);
      } catch (err) {
        result = {
          id: scenario?.id,
          name: scenario?.name,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      results.push(result);

      if (result.success) {
        this.emit('scenario:complete', result);
      } else {
        this.emit('scenario:error', result);
        if (!this.options.continueOnError) {
          const error = new Error(result.error ?? 'scenario failed');
          this.emit('batch:error', error);
          throw error;
        }
      }
    }

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.length - succeeded;
    const aggregateFinalValue = results.reduce(
      (sum, r) => sum + (r.success && typeof r.finalValue === 'number' ? r.finalValue : 0),
      0,
    );
    const aggregateInitial = scenarios.reduce(
      (sum, s) => sum + (typeof s?.initialValue === 'number' && isFinite(s.initialValue) ? s.initialValue : 0),
      0,
    );
    const aggregateReturn =
      aggregateInitial === 0 ? 0 : (aggregateFinalValue - aggregateInitial) / aggregateInitial;

    const summary: BatchSimulationSummary = {
      total: results.length,
      succeeded,
      failed,
      results,
      aggregateFinalValue,
      aggregateReturn,
    };

    this.emit('batch:complete', summary);
    return summary;
  }
}

// ---------------------------------------------------------------------------
// Invoice payment batch verifier (issue #219)
// ---------------------------------------------------------------------------

export interface BatchInvoiceValidation {
  invoiceId: string;
  valid: boolean;
  errors: string[];
  token: string;
  remainingAmount: bigint;
  status: string;
}

export interface BatchVerificationResult {
  valid: boolean;
  invoices: BatchInvoiceValidation[];
  commonToken: string | null;
  errors: string[];
}

/**
 * Result returned by the client's verifyBatchPay method.
 */
export interface VerifyBatchPayResult {
  valid: boolean;
  invoices: BatchInvoiceValidation[];
  commonToken: string | null;
  errors: string[];
}

/** A payment carrying its own already-resolved invoice, for the single-arg {@link verifyBatchPayments} overload. */
export interface SimpleBatchPayment {
  invoice: { id: string; status: string; token: string };
  token: string;
}

/** Result returned by the single-arg {@link verifyBatchPayments} overload. */
export interface SimpleBatchVerificationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Verify a batch of payments that each already carry their own resolved
 * invoice, checking that every invoice is `Pending` and that the payment's
 * token matches the invoice's token.
 */
export function verifyBatchPayments(payments: SimpleBatchPayment[]): SimpleBatchVerificationResult;
/**
 * Verify that all invoices in a batch share the same token and are in a
 * payable state, before submitting the on-chain transaction.
 *
 * @param invoices - The invoices to verify (must already be resolved).
 * @param payments - The proposed batch payments (invoiceId + amount pairs).
 */
export function verifyBatchPayments(
  invoices: Invoice[],
  payments: BatchPayment[]
): BatchVerificationResult;
export function verifyBatchPayments(
  invoicesOrPayments: Invoice[] | SimpleBatchPayment[],
  payments?: BatchPayment[]
): BatchVerificationResult | SimpleBatchVerificationResult {
  if (payments === undefined) {
    const simplePayments = invoicesOrPayments as SimpleBatchPayment[];
    const errors: string[] = [];
    for (const payment of simplePayments) {
      if (payment.invoice.status !== "Pending") {
        errors.push(
          `Invoice ${payment.invoice.id}: status is "${payment.invoice.status}", expected "Pending"`,
        );
      }
      if (payment.token !== payment.invoice.token) {
        errors.push(
          `Invoice ${payment.invoice.id}: token "${payment.token}" does not match invoice token "${payment.invoice.token}"`,
        );
      }
    }
    return { valid: errors.length === 0, errors };
  }

  const invoices = invoicesOrPayments as Invoice[];
  return verifyBatchPaymentsFull(invoices, payments);
}

function verifyBatchPaymentsFull(
  invoices: Invoice[],
  payments: BatchPayment[]
): BatchVerificationResult {
  const errors: string[] = [];
  const invoiceValidations: BatchInvoiceValidation[] = [];

  if (invoices.length === 0) {
    return { valid: false, invoices: [], commonToken: null, errors: ["No invoices provided"] };
  }

  const invoiceMap = new Map(invoices.map((inv) => [inv.id, inv]));
  const tokens = new Set<string>();

  for (const payment of payments) {
    const invoice = invoiceMap.get(payment.invoiceId);
    if (!invoice) {
      invoiceValidations.push({
        invoiceId: payment.invoiceId,
        valid: false,
        errors: ["Invoice not found"],
        token: "",
        remainingAmount: 0n,
        status: "unknown",
      });
      errors.push(`Invoice ${payment.invoiceId}: not found`);
      continue;
    }

    tokens.add(invoice.token);
    const invoiceErrors: string[] = [];

    if (invoice.status !== "Pending") {
      invoiceErrors.push(`Invoice status is "${invoice.status}", expected "Pending"`);
    }

    const totalOwed = invoice.recipients.reduce((sum, r) => sum + r.amount, 0n);
    const remaining = totalOwed - invoice.funded;
    if (payment.amount <= 0n) {
      invoiceErrors.push("Payment amount must be positive");
    }
    if (payment.amount > remaining) {
      invoiceErrors.push(
        `Payment amount ${payment.amount} exceeds remaining ${remaining}`
      );
    }

    invoiceValidations.push({
      invoiceId: payment.invoiceId,
      valid: invoiceErrors.length === 0,
      errors: invoiceErrors,
      token: invoice.token,
      remainingAmount: remaining,
      status: invoice.status,
    });

    if (invoiceErrors.length > 0) {
      errors.push(`Invoice ${payment.invoiceId}: ${invoiceErrors.join("; ")}`);
    }
  }

  const commonToken = tokens.size === 1 ? [...tokens][0]! : null;
  if (tokens.size > 1) {
    errors.push(`Invoices use different tokens: ${[...tokens].join(", ")}`);
  }

  const allValid = errors.length === 0;

  return { valid: allValid, invoices: invoiceValidations, commonToken, errors };
}

export default BatchVerifier;
