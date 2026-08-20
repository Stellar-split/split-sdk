import { describe, expect, it } from "vitest";
import { SdkError, SdkErrorCode, isSdkError } from "../src/errors.js";

describe("SdkError", () => {
  it("carries the correct error code", () => {
    const err = new SdkError(SdkErrorCode.INVOICE_NOT_FOUND, "Invoice not found");
    expect(err.code).toBe(SdkErrorCode.INVOICE_NOT_FOUND);
  });

  it("preserves the error message", () => {
    const msg = "Invoice not found: abc-123";
    const err = new SdkError(SdkErrorCode.INVOICE_NOT_FOUND, msg);
    expect(err.message).toBe(msg);
  });

  it("captures optional details", () => {
    const details = { invoiceId: "abc-123" };
    const err = new SdkError(SdkErrorCode.INVOICE_NOT_FOUND, "not found", details);
    expect(err.details).toEqual(details);
  });

  it("is an instance of Error", () => {
    const err = new SdkError(SdkErrorCode.NETWORK_TIMEOUT, "timeout");
    expect(err).toBeInstanceOf(Error);
  });

  it("has the correct name", () => {
    const err = new SdkError(SdkErrorCode.RATE_LIMITED, "rate limited");
    expect(err.name).toBe("SdkError");
  });

  it("captures a stack trace", () => {
    const err = new SdkError(SdkErrorCode.INSUFFICIENT_FUNDS, "insufficient funds");
    expect(err.stack).toBeDefined();
  });
});

describe("SdkErrorCode enum", () => {
  it("has all required values", () => {
    expect(SdkErrorCode.INVOICE_NOT_FOUND).toBe("INVOICE_NOT_FOUND");
    expect(SdkErrorCode.INSUFFICIENT_FUNDS).toBe("INSUFFICIENT_FUNDS");
    expect(SdkErrorCode.DEADLINE_EXPIRED).toBe("DEADLINE_EXPIRED");
    expect(SdkErrorCode.INVALID_RECIPIENT).toBe("INVALID_RECIPIENT");
    expect(SdkErrorCode.CONTRACT_REJECTED).toBe("CONTRACT_REJECTED");
    expect(SdkErrorCode.NETWORK_TIMEOUT).toBe("NETWORK_TIMEOUT");
    expect(SdkErrorCode.RATE_LIMITED).toBe("RATE_LIMITED");
  });
});

describe("isSdkError", () => {
  it("returns true for SdkError instances", () => {
    const err = new SdkError(SdkErrorCode.CONTRACT_REJECTED, "rejected");
    expect(isSdkError(err)).toBe(true);
  });

  it("returns false for regular Error instances", () => {
    const err = new Error("regular error");
    expect(isSdkError(err)).toBe(false);
  });

  it("returns false for null", () => {
    expect(isSdkError(null)).toBe(false);
  });

  it("returns false for plain objects", () => {
    expect(isSdkError({ code: "INVOICE_NOT_FOUND" })).toBe(false);
  });

  it("returns false for strings", () => {
    expect(isSdkError("error")).toBe(false);
  });
});