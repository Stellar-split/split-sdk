import { describe, it, expect } from "vitest";
import {
  validateInvoicePayload,
  PayloadSizeError,
} from "../src/payloadGuard.js";
import type { CreateInvoiceParams } from "../src/types.js";

function makeValidParams(overrides: Partial<CreateInvoiceParams> = {}): CreateInvoiceParams {
  return {
    creator: "GABCDEF123",
    recipients: [{ address: "GXYZ123", amount: 100n }],
    token: "USDC",
    deadline: 1_800_000_000,
    ...overrides,
  };
}

describe("PayloadGuard", () => {
  it("passes for a valid small payload", () => {
    expect(() => validateInvoicePayload(makeValidParams())).not.toThrow();
  });

  it("throws PayloadSizeError when recipients exceed maxRecipients", () => {
    const recipients = Array.from({ length: 51 }, (_, i) => ({
      address: `G${String(i).padStart(10, "0")}`,
      amount: 100n,
    }));
    const params = makeValidParams({ recipients });

    expect(() => validateInvoicePayload(params, { maxRecipients: 50 })).toThrow(PayloadSizeError);
  });

  it("throws PayloadSizeError when memo is too long", () => {
    const params = makeValidParams({ memo: "x".repeat(600) });

    expect(() => validateInvoicePayload(params, { maxMemoLength: 512 })).toThrow(PayloadSizeError);
  });

  it("throws PayloadSizeError when serialized size exceeds limit", () => {
    const recipients = Array.from({ length: 100 }, (_, i) => ({
      address: `GA${String(i).padStart(50, "0")}`,
      amount: 100n,
    }));
    const params = makeValidParams({ recipients });

    expect(() => validateInvoicePayload(params, { maxInvoiceSizeBytes: 2048 })).toThrow(PayloadSizeError);
  });

  it("reports all violations in the error", () => {
    const recipients = Array.from({ length: 100 }, (_, i) => ({
      address: `GA${String(i).padStart(50, "0")}`,
      amount: 100n,
    }));
    const params = makeValidParams({ recipients, memo: "x".repeat(600) });

    try {
      validateInvoicePayload(params, { maxRecipients: 10, maxMemoLength: 10, maxInvoiceSizeBytes: 512 });
    } catch (error) {
      expect(error).toBeInstanceOf(PayloadSizeError);
      const psError = error as PayloadSizeError;
      expect(psError.violations.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("detects oversize recipient addresses", () => {
    const params = makeValidParams({
      recipients: [{ address: "G".repeat(100), amount: 100n }],
    });

    expect(() => validateInvoicePayload(params)).toThrow(PayloadSizeError);
  });

  it("uses defaults when config is not provided", () => {
    expect(() => validateInvoicePayload(makeValidParams())).not.toThrow();
  });

  it("uses custom config when provided", () => {
    const params = makeValidParams({
      recipients: [
        { address: "GA", amount: 100n },
        { address: "GB", amount: 200n },
      ],
    });

    expect(() =>
      validateInvoicePayload(params, { maxRecipients: 1 })
    ).toThrow(PayloadSizeError);
  });
});
