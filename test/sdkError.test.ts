import { describe, it, expect } from "vitest";
import { SdkError, SdkErrorCode, isSdkError } from "../src/errors.js";

describe("SdkError", () => {
  it("carries the given code, message, and details", () => {
    const err = new SdkError("Invoice not found: inv-1", SdkErrorCode.INVOICE_NOT_FOUND, {
      invoiceId: "inv-1",
    });

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SdkError);
    expect(err.name).toBe("SdkError");
    expect(err.code).toBe(SdkErrorCode.INVOICE_NOT_FOUND);
    expect(err.message).toBe("Invoice not found: inv-1");
    expect(err.details).toEqual({ invoiceId: "inv-1" });
  });

  it("allows details to be omitted", () => {
    const err = new SdkError("Rate limited", SdkErrorCode.RATE_LIMITED);
    expect(err.details).toBeUndefined();
  });

  it.each([
    SdkErrorCode.INVOICE_NOT_FOUND,
    SdkErrorCode.INSUFFICIENT_FUNDS,
    SdkErrorCode.DEADLINE_EXPIRED,
    SdkErrorCode.INVALID_RECIPIENT,
    SdkErrorCode.CONTRACT_REJECTED,
    SdkErrorCode.NETWORK_TIMEOUT,
    SdkErrorCode.RATE_LIMITED,
  ])("preserves code %s", (code) => {
    const err = new SdkError("some message", code);
    expect(err.code).toBe(code);
  });
});

describe("isSdkError", () => {
  it("returns true for an SdkError instance", () => {
    const err = new SdkError("boom", SdkErrorCode.NETWORK_TIMEOUT);
    expect(isSdkError(err)).toBe(true);
  });

  it("returns false for a plain Error", () => {
    expect(isSdkError(new Error("plain"))).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(isSdkError(null)).toBe(false);
    expect(isSdkError(undefined)).toBe(false);
    expect(isSdkError("string")).toBe(false);
    expect(isSdkError({ code: SdkErrorCode.RATE_LIMITED })).toBe(false);
  });
});
