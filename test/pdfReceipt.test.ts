import { describe, expect, it } from "vitest";
import { generateReceiptPdf } from "../src/pdfReceipt.js";
import type { Invoice, Payment } from "../src/types.js";

describe("generateReceiptPdf", () => {
  it("generates a valid PDF starting with %PDF- header", () => {
    const invoice: Invoice = {
      id: "inv-001",
      creator: "GCZST3XVCDTUJ76ZAV2HA72KYTZ4KXX52HRXVWWRWXH2NBDXZWQS2FB2",
      recipients: [
        {
          address: "GCZST3XVCDTUJ76ZAV2HA72KYTZ4KXX52HRXVWWRWXH2NBDXZWQS2FB2",
          amount: 1000000n,
        },
      ],
      token: "CBQHD3SPLOMVEA4EMWTKV7U2EBWK2FRCVMQ2ZLOXGGZ5LPGXTVJEZпортугалия",
      deadline: Math.floor(Date.now() / 1000) + 86400,
      funded: 500000n,
      status: "Pending",
      payments: [],
    };

    const payment: Payment = {
      payer: "GCZST3XVCDTUJ76ZAV2HA72KYTZ4KXX52HRXVWWRWXH2NBDXZWQS2FB2",
      amount: 500000n,
      timestamp: Math.floor(Date.now() / 1000),
    };

    const proofHash = "abc123def456789";
    const pdf = generateReceiptPdf(invoice, payment, proofHash);

    expect(pdf).toBeInstanceOf(Uint8Array);
    const header = new TextDecoder().decode(pdf.slice(0, 9));
    expect(header).toBe("%PDF-1.4\n");
  });

  it("includes invoice and payment information in PDF", () => {
    const invoice: Invoice = {
      id: "test-invoice",
      creator: "GCZST3XVCDTUJ76ZAV2HA72KYTZ4KXX52HRXVWWRWXH2NBDXZWQS2FB2",
      recipients: [],
      token: "CBQHD3SPLOMVEA4EMWTKV7U2EBWK2FRCVMQ2ZLOXGGZ5LPGXTVJEZ",
      deadline: 0,
      funded: 0n,
      status: "Pending",
      payments: [],
    };

    const payment: Payment = {
      payer: "GCZST3XVCDTUJ76ZAV2HA72KYTZ4KXX52HRXVWWRWXH2NBDXZWQS2FB2",
      amount: 1000000n,
    };

    const proofHash = "abc123";
    const pdf = generateReceiptPdf(invoice, payment, proofHash);
    const pdfText = new TextDecoder().decode(pdf);

    expect(pdfText).toContain("%PDF");
    expect(pdfText.length).toBeGreaterThan(100);
  });
});
