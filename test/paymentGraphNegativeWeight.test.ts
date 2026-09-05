import { describe, it, expect } from "vitest";
import { PaymentGraphChecker, GraphValidationError } from "../src/graph/PaymentGraphChecker.js";
import type { Invoice } from "../src/types.js";

describe("PaymentGraphChecker negative-weight detection", () => {
  const checker = new PaymentGraphChecker({ horizonUrl: "https://horizon.stellar.org" });

  it("throws GraphValidationError when a recipient has negative amount", async () => {
    const invoice: Invoice = {
      id: "inv-1",
      token: "native",
      creator: "GABC...",
      amount: 1000n,
      recipients: [
        { address: "GDEF...", amount: -100n },
      ],
      status: "pending",
      createdAt: new Date(),
      deadline: new Date(Date.now() + 86400000),
    };

    await expect(checker.check(invoice)).rejects.toThrow(GraphValidationError);
  });

  it("error message names the offending edge", async () => {
    const invoice: Invoice = {
      id: "inv-1",
      token: "native",
      creator: "GSOURCE...",
      amount: 1000n,
      recipients: [
        { address: "GTARGET...", amount: -50n },
      ],
      status: "pending",
      createdAt: new Date(),
      deadline: new Date(Date.now() + 86400000),
    };

    try {
      await checker.check(invoice);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GraphValidationError);
      expect((err as Error).message).toContain("GSOURCE...");
      expect((err as Error).message).toContain("GTARGET...");
      expect((err as Error).message).toContain("-50");
    }
  });

  it("passes when all amounts are non-negative", async () => {
    const invoice: Invoice = {
      id: "inv-1",
      token: "native",
      creator: "GABC...",
      amount: 1000n,
      recipients: [
        { address: "GDEF...", amount: 0n },
        { address: "GHIJ...", amount: 100n },
      ],
      status: "pending",
      createdAt: new Date(),
      deadline: new Date(Date.now() + 86400000),
    };

    // findPath will likely fail because we're not mocking Horizon,
    // but the negative-weight check should pass first.
    await expect(checker.check(invoice, { allowUnreachable: true })).resolves.toBeDefined();
  });
});
