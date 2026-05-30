import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { enrichInvoice } from "../src/enricher.js";

const invoice = {
  id: "1",
  creator: "GABC",
  recipients: [],
  token: "USDC",
  deadline: 1,
  funded: 0n,
  status: "Pending" as const,
  payments: [],
  memo: "ipfs:QmTestCid",
};

describe("enrichInvoice", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ name: "Invoice metadata" }),
    })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches metadata from IPFS and merges it into the invoice", async () => {
    const result = await enrichInvoice("1", async () => invoice);

    expect(result.id).toBe("1");
    expect(result.metadata).toEqual({ name: "Invoice metadata" });
  });

  it("returns metadata null when memo has no IPFS CID", async () => {
    const bareInvoice = { ...invoice, memo: undefined };
    const result = await enrichInvoice("1", async () => bareInvoice);

    expect(result.id).toBe("1");
    expect(result.metadata).toBeNull();
  });
});
