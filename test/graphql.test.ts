import { describe, expect, it } from "vitest";
import {
  buildInvoiceQuery,
  buildInvoicesByCreatorQuery,
  type InvoiceQueryResponse,
  type InvoicesByCreatorQueryResponse,
} from "../src/graphql.js";

describe("graphql query builders", () => {
  it("returns typed invoice query definitions", () => {
    const query = buildInvoiceQuery("inv-1");
    const result: InvoiceQueryResponse = { invoice: null };

    expect(query.variables.id).toBe("inv-1");
    expect(result.invoice).toBeNull();
  });

  it("returns typed creator query definitions", () => {
    const query = buildInvoicesByCreatorQuery("GCREATOR");
    const result: InvoicesByCreatorQueryResponse = { invoicesByCreator: [] };

    expect(query.variables.address).toBe("GCREATOR");
    expect(result.invoicesByCreator).toEqual([]);
  });
});
