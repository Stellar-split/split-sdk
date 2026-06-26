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
  const contractId = "CA3D5K7R2U5J6Y7K8R9A0B1C2D3E4F5G6H7I8J9K0L1M2N3O4P5Q6R7S8T9U";

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
  const contractId = "CA3D5K7R2U5J6Y7K8R9A0B1C2D3E4F5G6H7I8J9K0L1M2N3O4P5Q6R7S8T9U";

  it("builds a ledger key for an invoice storage entry", () => {
    const ledgerKey = buildInvoiceDataLedgerKey(contractId, "1");
    expect(ledgerKey.switch()).toBe(xdr.LedgerEntryType.contractData());
  });
});
