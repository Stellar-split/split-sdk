import { describe, it, expect } from "vitest";
import {
  serializeInvoiceTemplate,
  deserializeInvoiceTemplate,
  ValidationError,
} from "../src/invoiceTemplate.js";
import type { CreateInvoiceParams } from "../src/types.js";

const sample: CreateInvoiceParams = {
  creator: "GABC123",
  recipients: [
    { address: "GDEF456", amount: 60_000_000n },
    { address: "GHIJ789", amount: 40_000_000n },
  ],
  token: "GUSDC",
  deadline: 1_800_000_000,
};

describe("serializeInvoiceTemplate", () => {
  it("returns a JSON string", () => {
    expect(typeof serializeInvoiceTemplate(sample)).toBe("string");
  });

  it("produces versioned envelope { v: 1, data: {...} }", () => {
    const parsed = JSON.parse(serializeInvoiceTemplate(sample));
    expect(parsed.v).toBe(1);
    expect(parsed.data).toBeDefined();
  });

  it("serializes bigint amounts as decimal strings", () => {
    const parsed = JSON.parse(serializeInvoiceTemplate(sample));
    expect(parsed.data.recipients[0].amount).toBe("60000000");
    expect(parsed.data.recipients[1].amount).toBe("40000000");
  });

  it("preserves address strings verbatim", () => {
    const parsed = JSON.parse(serializeInvoiceTemplate(sample));
    expect(parsed.data.creator).toBe("GABC123");
    expect(parsed.data.recipients[0].address).toBe("GDEF456");
  });
});

describe("deserializeInvoiceTemplate", () => {
  it("round-trips: deserialize(serialize(params)) === params", () => {
    const result = deserializeInvoiceTemplate(serializeInvoiceTemplate(sample));
    expect(result.creator).toBe(sample.creator);
    expect(result.token).toBe(sample.token);
    expect(result.deadline).toBe(sample.deadline);
    expect(result.recipients[0]!.address).toBe(sample.recipients[0]!.address);
    expect(result.recipients[0]!.amount).toBe(sample.recipients[0]!.amount);
    expect(result.recipients[1]!.address).toBe(sample.recipients[1]!.address);
    expect(result.recipients[1]!.amount).toBe(sample.recipients[1]!.amount);
  });

  it("restores bigint amounts", () => {
    const result = deserializeInvoiceTemplate(serializeInvoiceTemplate(sample));
    expect(typeof result.recipients[0]!.amount).toBe("bigint");
  });

  it("throws ValidationError for invalid JSON", () => {
    expect(() => deserializeInvoiceTemplate("not json")).toThrow(ValidationError);
  });

  it("throws ValidationError when v is wrong", () => {
    const bad = JSON.stringify({ v: 2, data: {} });
    expect(() => deserializeInvoiceTemplate(bad)).toThrow(ValidationError);
  });

  it("throws ValidationError when data is missing", () => {
    const bad = JSON.stringify({ v: 1 });
    expect(() => deserializeInvoiceTemplate(bad)).toThrow(ValidationError);
  });

  it("throws ValidationError when creator is missing", () => {
    const bad = JSON.stringify({
      v: 1,
      data: { creator: "", recipients: [], token: "G", deadline: 1 },
    });
    expect(() => deserializeInvoiceTemplate(bad)).toThrow(ValidationError);
  });

  it("throws ValidationError when token is missing", () => {
    const bad = JSON.stringify({
      v: 1,
      data: { creator: "G", recipients: [], token: "", deadline: 1 },
    });
    expect(() => deserializeInvoiceTemplate(bad)).toThrow(ValidationError);
  });

  it("throws ValidationError when deadline is not a number", () => {
    const bad = JSON.stringify({
      v: 1,
      data: { creator: "G", recipients: [], token: "G", deadline: "bad" },
    });
    expect(() => deserializeInvoiceTemplate(bad)).toThrow(ValidationError);
  });

  it("throws ValidationError when a recipient amount is not a decimal string", () => {
    const bad = JSON.stringify({
      v: 1,
      data: {
        creator: "G",
        recipients: [{ address: "G", amount: "notanumber" }],
        token: "G",
        deadline: 1,
      },
    });
    expect(() => deserializeInvoiceTemplate(bad)).toThrow(ValidationError);
  });

  it("throws ValidationError when a recipient address is empty", () => {
    const bad = JSON.stringify({
      v: 1,
      data: {
        creator: "G",
        recipients: [{ address: "", amount: "100" }],
        token: "G",
        deadline: 1,
      },
    });
    expect(() => deserializeInvoiceTemplate(bad)).toThrow(ValidationError);
  });
});
