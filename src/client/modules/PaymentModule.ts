import { BaseClientModule } from "./BaseModule.js";
import type {
  PayParams,
  SimulationResult,
  SimulatePayResult,
  Payment,
  PaymentReceipt,
  InvoiceReceipt,
  PaymentReconciliationReport,
  ClaimableRefundEntry,
  BatchPayment,
  PaymentValidationResult,
  PaymentValidationOptions,
} from "../../types.js";
import type { TxResult } from "../../client.js";
import type { BatchVerificationResult } from "../../batchVerifier.js";
import { withTrace } from "../../tracing.js";

/**
 * Module dedicated to Payment operations: payments, receipts, refunds,
 * batch payments, verification, and reconciliations.
 */
export class PaymentModule extends BaseClientModule {
  /**
   * Submits a payment toward an invoice, or simulates when `simulate: true`.
   */
  async pay(params: PayParams & { simulate: true }): Promise<SimulationResult>;
  async pay(params: PayParams): Promise<TxResult>;
  async pay(params: PayParams): Promise<TxResult | SimulationResult> {
    return withTrace("pay", () => this.client.pay(params as any));
  }

  /**
   * Simulates a payment without submitting it to the network.
   */
  async simulatePay(params: PayParams): Promise<SimulatePayResult> {
    return withTrace("simulatePay", () => this.client.simulatePay(params));
  }

  /**
   * Executes a batch of payments across multiple invoices.
   */
  async batchPay(payer: string, payments: BatchPayment[]): Promise<TxResult> {
    return withTrace("batchPay", () => this.client.batchPay(payer, payments));
  }

  /**
   * Verifies batch payments before submission.
   */
  async verifyBatchPay(payments: BatchPayment[]): Promise<BatchVerificationResult> {
    return this.client.verifyBatchPay(payments);
  }

  /**
   * Validates a proposed payment against invoice requirements.
   */
  async validate(
    invoiceId: string,
    amount: bigint,
    options?: PaymentValidationOptions
  ): Promise<PaymentValidationResult> {
    return this.client.validatePayment(invoiceId, amount, options);
  }

  /** Alias for `validate`. */
  async validatePayment(
    invoiceId: string,
    amount: bigint,
    options?: PaymentValidationOptions
  ): Promise<PaymentValidationResult> {
    return this.validate(invoiceId, amount, options);
  }

  /**
   * Reconciles recorded invoice payments with contract events.
   */
  async reconcile(invoiceId: string): Promise<PaymentReconciliationReport> {
    return this.client.reconcilePayments(invoiceId);
  }

  /** Alias for `reconcile`. */
  async reconcilePayments(invoiceId: string): Promise<PaymentReconciliationReport> {
    return this.reconcile(invoiceId);
  }

  /**
   * Gets a payment receipt for a specific payer on an invoice.
   */
  async getReceipt(invoiceId: string, payerAddress: string): Promise<PaymentReceipt> {
    return this.client.getReceipt(invoiceId, payerAddress);
  }

  /**
   * Generates a full invoice receipt once released.
   */
  async generateReceipt(invoiceId: string): Promise<InvoiceReceipt> {
    return this.client.generateReceipt(invoiceId);
  }

  /**
   * Refunds payments from an invoice.
   */
  async refund(
    invoiceId: string,
    caller?: string,
    options?: { fallbackToClaimableBalance?: boolean }
  ): Promise<TxResult>;
  async refund(
    invoiceId: string,
    caller: string,
    options: { fallbackToClaimableBalance: true }
  ): Promise<TxResult | { txHash: string; claimableBalanceId: string }>;
  async refund(
    invoiceId: string,
    caller?: string,
    options?: { fallbackToClaimableBalance?: boolean }
  ): Promise<TxResult | { txHash: string; claimableBalanceId: string }> {
    return withTrace("refund", () =>
      this.client.refundInvoice(invoiceId, caller as any, options as any)
    );
  }

  /** Alias for `refund`. */
  async refundInvoice(
    invoiceId: string,
    caller?: string,
    options?: { fallbackToClaimableBalance?: boolean }
  ): Promise<TxResult | { txHash: string; claimableBalanceId: string }> {
    return this.refund(invoiceId, caller as any, options as any);
  }

  /**
   * Gets claimable refund entries for a payer address.
   */
  async getClaimableRefunds(payer: string): Promise<ClaimableRefundEntry[]> {
    return this.client.getClaimableRefunds(payer);
  }

  /**
   * Gets the list of payments made to an invoice.
   */
  async getPayments(invoiceId: string): Promise<Payment[]> {
    return this.client.getPayments(invoiceId);
  }

  /**
   * Retrieves full chronological payment history for an invoice.
   */
  async getHistory(invoiceId: string): Promise<Payment[]> {
    return this.client.getPaymentHistory(invoiceId);
  }

  /** Alias for `getHistory`. */
  async getPaymentHistory(invoiceId: string): Promise<Payment[]> {
    return this.getHistory(invoiceId);
  }

  /**
   * Reroutes an invoice recipient to a new address.
   */
  async rerouteRecipient(invoiceId: string, oldAddress: string, newAddress: string): Promise<TxResult> {
    return this.client.rerouteRecipient(invoiceId, oldAddress, newAddress);
  }

  /**
   * Checks payment cooldown status for a payer on an invoice.
   */
  async getCooldown(invoiceId: string, payer: string) {
    return this.client.getPaymentCooldown(invoiceId, payer);
  }

  /** Alias for `getCooldown`. */
  async getPaymentCooldown(invoiceId: string, payer: string) {
    return this.getCooldown(invoiceId, payer);
  }

  /**
   * Submits a payment accompanied by an attestation.
   */
  async payWithAttestation(params: {
    invoiceId: string;
    amount: bigint;
    payer: string;
    attestationStatement: string;
  }): Promise<TxResult> {
    return withTrace("payWithAttestation", () => this.client.payWithAttestation(params));
  }

  /**
   * Submits a payment with referral attribution.
   */
  async payWithReferral(params: {
    invoiceId: string;
    amount: bigint;
    payer: string;
    referrer: string;
  }): Promise<TxResult> {
    return withTrace("payWithReferral", () => this.client.payWithReferral(params));
  }

  /**
   * Retrieves any pending payout for a recipient.
   */
  async getPendingPayout(invoiceId: string, recipient: string): Promise<bigint> {
    return this.client.getPendingPayout(invoiceId, recipient);
  }

  /**
   * Claims a pending payout for a recipient.
   */
  async claimPendingPayout(invoiceId: string, recipient: string): Promise<TxResult> {
    return this.client.claimPendingPayout(invoiceId, recipient);
  }
}
