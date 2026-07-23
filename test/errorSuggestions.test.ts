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
} from "../src/errors.js";

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
