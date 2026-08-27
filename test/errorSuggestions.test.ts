import { describe, it, expect } from "vitest";
import { getSuggestion } from "../src/errorSuggestions.js";
import {
  StellarSplitError,
  InvoiceNotFoundError,
  InvoiceNotPendingError,
  DeadlinePassedError,
  PaymentExceedsRemainingError,
  InvoiceFrozenError,
  CoCreatorApprovalNotRequiredError,
  SdkError,
  SdkErrorCode,
} from "../src/errors.js";

const ACCOUNT_NOT_FOUND_SUGGESTION =
  "The account does not exist on the Stellar network. Fund the account with a minimum XLM balance before retrying.";

describe("getSuggestion — typed error classes", () => {
  it("returns suggestion for InvoiceNotFoundError", () => {
    const s = getSuggestion(new InvoiceNotFoundError("inv-1"));
    expect(s).toContain("does not exist on-chain");
  });

  it("returns suggestion for InvoiceNotPendingError", () => {
    const s = getSuggestion(new InvoiceNotPendingError("inv-2"));
    expect(s).toContain("Pending status");
  });

  it("returns suggestion for DeadlinePassedError", () => {
    const s = getSuggestion(new DeadlinePassedError("inv-3"));
    expect(s).toContain("deadline has passed");
  });

  it("returns suggestion for PaymentExceedsRemainingError", () => {
    const s = getSuggestion(new PaymentExceedsRemainingError("inv-4"));
    expect(s).toContain("remaining unfunded balance");
  });

  it("returns suggestion for InvoiceFrozenError", () => {
    const s = getSuggestion(new InvoiceFrozenError("inv-5"));
    expect(s).toContain("frozen");
  });

  it("returns suggestion for CoCreatorApprovalNotRequiredError", () => {
    const s = getSuggestion(new CoCreatorApprovalNotRequiredError("inv-6"));
    expect(s).toContain("co-creator approval");
  });
});

describe("getSuggestion — raw-message pattern matching", () => {
  it("returns suggestion for unauthorized raw error", () => {
    const err = new StellarSplitError("contract panic: unauthorized", "contract panic: unauthorized");
    const s = getSuggestion(err);
    expect(s).toContain("not authorized");
  });

  it("returns suggestion for insufficient fee raw error", () => {
    const err = new StellarSplitError("insufficient fee", "insufficient fee");
    const s = getSuggestion(err);
    expect(s).toContain("fee");
  });

  it("returns suggestion for trustline missing raw error", () => {
    const err = new StellarSplitError("trustline missing", "trustline missing");
    const s = getSuggestion(err);
    expect(s).toContain("trustline");
  });

  it("returns suggestion for account not found raw error", () => {
    const err = new StellarSplitError("account not found", "account not found");
    const s = getSuggestion(err);
    expect(s).toContain("does not exist on the Stellar network");
  });
});

describe("getSuggestion — machine-readable error codes", () => {
  it("returns the account-specific suggestion for the ACCOUNT_NOT_FOUND code", () => {
    expect(getSuggestion("ACCOUNT_NOT_FOUND")).toBe(ACCOUNT_NOT_FOUND_SUGGESTION);
  });

  it("normalizes code casing before lookup", () => {
    expect(getSuggestion("account_not_found")).toBe(ACCOUNT_NOT_FOUND_SUGGESTION);
  });

  it("resolves an SdkErrorCode enum value", () => {
    expect(getSuggestion(SdkErrorCode.ACCOUNT_NOT_FOUND)).toBe(ACCOUNT_NOT_FOUND_SUGGESTION);
  });

  it("resolves an SdkError instance via its code", () => {
    const err = new SdkError("account missing", SdkErrorCode.ACCOUNT_NOT_FOUND);
    expect(getSuggestion(err)).toBe(ACCOUNT_NOT_FOUND_SUGGESTION);
  });

  it("does not affect other error-code suggestions", () => {
    expect(getSuggestion("INVOICE_NOT_FOUND")).toContain("does not exist on-chain");
    expect(getSuggestion("RATE_LIMITED")).toContain("rate limited");
    expect(getSuggestion("INVOICE_NOT_FOUND")).not.toBe(ACCOUNT_NOT_FOUND_SUGGESTION);
  });

  it("falls back to the generic suggestion for an unknown code", () => {
    expect(getSuggestion("NOPE_NOT_A_CODE")).toContain("unexpected error");
  });
});

describe("getSuggestion — fallback for unknown errors", () => {
  it("returns generic fallback for an unknown Error", () => {
    const s = getSuggestion(new Error("something weird happened"));
    expect(s).toContain("unexpected error");
  });

  it("returns generic fallback for an unknown StellarSplitError with no pattern match", () => {
    const s = getSuggestion(new StellarSplitError("completely unknown contract error"));
    expect(s).toContain("unexpected error");
  });
});
