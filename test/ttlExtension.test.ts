import { describe, expect, it } from "vitest";
import {
  buildInvoiceStorageKey,
  buildInvoiceDataLedgerKey,
  buildContractDataLedgerKey,
} from "../src/ttlExtension.js";
import { nativeToScVal, xdr } from "@stellar/stellar-sdk";

describe("buildInvoiceStorageKey", () => {
  it("returns an ScVal u64 for the invoice ID", () => {
    const key = buildInvoiceStorageKey("42");
    const expected = nativeToScVal(BigInt(42), { type: "u64" });
    expect(key.toXDR("base64")).toBe(expected.toXDR("base64"));
  });

  it("handles large invoice IDs", () => {
    const key = buildInvoiceStorageKey("18446744073709551615");
    const expected = nativeToScVal(BigInt("18446744073709551615"), {
      type: "u64",
    });
    expect(key.toXDR("base64")).toBe(expected.toXDR("base64"));
  });
});

describe("buildContractDataLedgerKey", () => {
  const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

  it("creates a LedgerKey for persistent contract data", () => {
    const key = nativeToScVal("test", { type: "symbol" });
    const ledgerKey = buildContractDataLedgerKey(contractId, key, "persistent");

    expect(ledgerKey.switch()).toBe(xdr.LedgerEntryType.contractData());
  });

  it("creates a LedgerKey for temporary contract data", () => {
    const key = nativeToScVal("test", { type: "symbol" });
    const ledgerKey = buildContractDataLedgerKey(contractId, key, "temporary");

    expect(ledgerKey.switch()).toBe(xdr.LedgerEntryType.contractData());
  });
});

describe("buildInvoiceDataLedgerKey", () => {
  const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

  it("builds a ledger key for an invoice storage entry", () => {
    const ledgerKey = buildInvoiceDataLedgerKey(contractId, "1");
    expect(ledgerKey.switch()).toBe(xdr.LedgerEntryType.contractData());
  });
});
