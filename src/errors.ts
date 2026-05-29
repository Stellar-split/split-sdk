/**
 * Typed error hierarchy for StellarSplit SDK.
 *
 * Maps known Soroban contract panic messages to structured subclasses
 * so callers can handle specific failure cases with instanceof checks.
 */

/** Base class for all StellarSplit SDK errors. */
export class StellarSplitError extends Error {
  /** The raw error string from the Soroban RPC, if available. */
  readonly raw: string;

  constructor(message: string, raw: string = message) {
    super(message);
    this.name = "StellarSplitError";
    this.raw = raw;
    // Maintain proper prototype chain in transpiled environments
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when the requested invoice does not exist on-chain. */
export class InvoiceNotFoundError extends StellarSplitError {
  readonly invoiceId: string;

  constructor(invoiceId: string, raw?: string) {
    super(`Invoice not found: ${invoiceId}`, raw ?? `Invoice not found: ${invoiceId}`);
    this.name = "InvoiceNotFoundError";
    this.invoiceId = invoiceId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when an operation requires the invoice to be Pending but it is not. */
export class InvoiceNotPendingError extends StellarSplitError {
  readonly invoiceId: string;

  constructor(invoiceId: string, raw?: string) {
    super(`Invoice is not in Pending state: ${invoiceId}`, raw);
    this.name = "InvoiceNotPendingError";
    this.invoiceId = invoiceId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when a transaction is attempted after the invoice deadline has passed. */
export class DeadlinePassedError extends StellarSplitError {
  readonly invoiceId: string;

  constructor(invoiceId: string, raw?: string) {
    super(`Invoice deadline has passed: ${invoiceId}`, raw);
    this.name = "DeadlinePassedError";
    this.invoiceId = invoiceId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when a payment amount exceeds the remaining unfunded balance. */
export class PaymentExceedsRemainingError extends StellarSplitError {
  readonly invoiceId: string;

  constructor(invoiceId: string, raw?: string) {
    super(`Payment exceeds remaining balance for invoice: ${invoiceId}`, raw);
    this.name = "PaymentExceedsRemainingError";
    this.invoiceId = invoiceId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when an operation is attempted on a frozen (disputed/locked) invoice. */
export class InvoiceFrozenError extends StellarSplitError {
  readonly invoiceId: string;

  constructor(invoiceId: string, raw?: string) {
    super(`Invoice is frozen: ${invoiceId}`, raw);
    this.name = "InvoiceFrozenError";
    this.invoiceId = invoiceId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Error message patterns from the Soroban contract
// ---------------------------------------------------------------------------

const ERROR_PATTERNS: Array<{
  pattern: RegExp;
  factory: (invoiceId: string, raw: string) => StellarSplitError;
}> = [
  {
    pattern: /not.found|invoice.*does.*not.*exist|no.*invoice/i,
    factory: (id, raw) => new InvoiceNotFoundError(id, raw),
  },
  {
    pattern: /not.*pending|invalid.*status|wrong.*state/i,
    factory: (id, raw) => new InvoiceNotPendingError(id, raw),
  },
  {
    pattern: /deadline.*passed|expired|past.*deadline/i,
    factory: (id, raw) => new DeadlinePassedError(id, raw),
  },
  {
    pattern: /exceeds.*remaining|overpayment|amount.*too.*large/i,
    factory: (id, raw) => new PaymentExceedsRemainingError(id, raw),
  },
  {
    pattern: /frozen|disputed|locked/i,
    factory: (id, raw) => new InvoiceFrozenError(id, raw),
  },
];

/**
 * Parse a raw Soroban error string and return the appropriate typed error.
 *
 * @param raw       - The raw error message from the RPC.
 * @param invoiceId - The invoice ID involved in the operation, if known.
 * @returns A typed StellarSplitError subclass, or a generic StellarSplitError.
 */
export function parseSorobanError(raw: string, invoiceId: string = ""): StellarSplitError {
  for (const { pattern, factory } of ERROR_PATTERNS) {
    if (pattern.test(raw)) {
      return factory(invoiceId, raw);
    }
  }
  return new StellarSplitError(raw, raw);
}
