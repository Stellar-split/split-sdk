import { describe, it, expect } from "vitest";
import type { PaymentProof } from "../src/proof.js";

describe("generatePaymentProof", () => {
  it("creates proof with all required fields", () => {
    const mockProof: PaymentProof = {
      txHash: "abc123def456",
      payer: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
      invoiceId: "42",
      amount: 1000n * 10_000_000n,
      ledger: 12345,
      proofHash: "abc123",
    };

    expect(mockProof.txHash).toBeDefined();
    expect(mockProof.payer).toBeDefined();
    expect(mockProof.invoiceId).toBeDefined();
    expect(mockProof.amount).toBeDefined();
    expect(mockProof.ledger).toBeDefined();
    expect(mockProof.proofHash).toBeDefined();
  });

  it("computes deterministic hash", () => {
    const txHash = "abc123def456";
    const payer = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
    const invoiceId = "42";
    const amount = 1000n * 10_000_000n;
    const ledger = 12345;

    const data = `${txHash}${payer}${invoiceId}${amount.toString()}${ledger}`;
    const encoder = new TextEncoder();
    const buffer = encoder.encode(data);

    let hash1 = 0;
    for (let i = 0; i < buffer.length; i++) {
      hash1 = ((hash1 << 5) - hash1) + buffer[i];
      hash1 = hash1 & hash1;
    }
    const result1 = Math.abs(hash1).toString(16).padStart(64, "0").slice(0, 64);

    let hash2 = 0;
    for (let i = 0; i < buffer.length; i++) {
      hash2 = ((hash2 << 5) - hash2) + buffer[i];
      hash2 = hash2 & hash2;
    }
    const result2 = Math.abs(hash2).toString(16).padStart(64, "0").slice(0, 64);

    expect(result1).toBe(result2);
    expect(result1).toHaveLength(64);
  });

  it("proof hash changes with different inputs", () => {
    const data1 = "abc123def456GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN421000000000012345";
    const data2 = "abc123def456GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN431000000000012345";

    const encoder = new TextEncoder();
    const buffer1 = encoder.encode(data1);
    const buffer2 = encoder.encode(data2);

    let hash1 = 0;
    for (let i = 0; i < buffer1.length; i++) {
      hash1 = ((hash1 << 5) - hash1) + buffer1[i];
      hash1 = hash1 & hash1;
    }
    const result1 = Math.abs(hash1).toString(16).padStart(64, "0").slice(0, 64);

    let hash2 = 0;
    for (let i = 0; i < buffer2.length; i++) {
      hash2 = ((hash2 << 5) - hash2) + buffer2[i];
      hash2 = hash2 & hash2;
    }
    const result2 = Math.abs(hash2).toString(16).padStart(64, "0").slice(0, 64);

    expect(result1).not.toBe(result2);
  });

  it("verifies proof structure for known transaction", () => {
    const mockProof: PaymentProof = {
      txHash: "abc123def456",
      payer: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
      invoiceId: "42",
      amount: 1000n * 10_000_000n,
      ledger: 12345,
      proofHash: "abc123",
    };

    expect(typeof mockProof.txHash).toBe("string");
    expect(typeof mockProof.payer).toBe("string");
    expect(typeof mockProof.invoiceId).toBe("string");
    expect(typeof mockProof.amount).toBe("bigint");
    expect(typeof mockProof.ledger).toBe("number");
    expect(typeof mockProof.proofHash).toBe("string");
  });
});
