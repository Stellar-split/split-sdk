import { describe, it, expect } from "vitest";
import { isValidAddress } from "../src/utils.js";
import {
  createMockInvoice,
  createMockPayment,
  createMockRecipient,
} from "../src/testing/index.js";

describe("Testing factories", () => {
  it("creates a mock recipient with valid defaults", () => {
    const recipient = createMockRecipient();

    expect(isValidAddress(recipient.address)).toBe(true);
    expect(recipient.amount).toBeGreaterThan(0n);
  });

  it("allows overriding recipient fields", () => {
    const recipient = createMockRecipient({ amount: 50_000_000n });

    expect(recipient.amount).toBe(50_000_000n);
  });

  it("creates a mock payment with valid defaults", () => {
    const payment = createMockPayment();

    expect(isValidAddress(payment.payer)).toBe(true);
    expect(payment.amount).toBeGreaterThan(0n);
  });

  it("allows overriding payment fields", () => {
    const payment = createMockPayment({ amount: 20_000_000n });

    expect(payment.amount).toBe(20_000_000n);
  });

  it("creates a mock invoice with realistic defaults", () => {
    const invoice = createMockInvoice();
    const now = Math.floor(Date.now() / 1000);

    expect(invoice.id).toBe("123");
    expect(isValidAddress(invoice.creator)).toBe(true);
    expect(invoice.recipients.length).toBeGreaterThan(0);
    expect(invoice.payments.length).toBeGreaterThanOrEqual(1);
    expect(invoice.token.startsWith("CA")).toBe(true);
    expect(invoice.deadline).toBeGreaterThan(now);
    expect(invoice.funded).toBeGreaterThanOrEqual(0n);
    expect(invoice.status).toBe("Pending");
  });

  it("merges invoice overrides correctly", () => {
    const recipient = createMockRecipient({ amount: 5_000_000n });
    const invoice = createMockInvoice({
      id: "999",
      status: "Released",
      recurring: true,
      recipients: [recipient],
      payments: [createMockPayment({ amount: 5_000_000n })],
      funded: 5_000_000n,
    });

    expect(invoice.id).toBe("999");
    expect(invoice.status).toBe("Released");
    expect(invoice.recurring).toBe(true);
    expect(invoice.recipients).toEqual([recipient]);
    expect(invoice.payments[0].amount).toBe(5_000_000n);
    expect(invoice.funded).toBe(5_000_000n);
  });
});
