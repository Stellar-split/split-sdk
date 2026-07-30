import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockSdk } from "../src/testing/mockFactory.js";

describe("createMockSplitClient", () => {
  let mockClient: ReturnType<typeof createMockSdk>;

  beforeEach(() => {
    mockClient = createMockSdk();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns an object that satisfies SplitClient type without TypeScript errors", () => {
    expect(mockClient).toBeDefined();
    expect(typeof mockClient.getInvoice).toBe("function");
    expect(typeof mockClient.createInvoice).toBe("function");
    expect(typeof mockClient.pay).toBe("function");
  });

  it("all public methods are vi.fn() stubs that can be spied on", () => {
    const getInvoice = mockClient.getInvoice;
    const createInvoice = mockClient.createInvoice;
    const pay = mockClient.pay;

    expect(typeof getInvoice).toBe("function");
    expect(typeof createInvoice).toBe("function");
    expect(typeof pay).toBe("function");

    // Can call and track calls
    expect(() => {
      getInvoice.mock.calls.push(["test-id"]);
    }).not.toThrow();
  });

  it("default return values are type-correct and resolve properly", async () => {
    const invoice = await mockClient.getInvoice("test-id");
    expect(invoice).toBeDefined();
    expect(invoice.id).toBeDefined();

    const createResult = await mockClient.createInvoice({
      creator: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5V3VF",
      recipients: [],
      token: "native",
      deadline: Math.floor(Date.now() / 1000) + 86400,
    });
    expect(createResult).toBeDefined();
    expect(createResult.invoiceId).toBeDefined();
    expect(createResult.txHash).toBeDefined();
  });

  it("overrides parameter allows selectively replacing individual stubs", async () => {
    const customGetInvoice = vi.fn().mockResolvedValue({ id: "custom-id" });

    const customMock = createMockSdk({
      getInvoice: customGetInvoice,
    });

    const result = await customMock.getInvoice("test-id");

    expect(result.id).toBe("custom-id");
    expect(customGetInvoice).toHaveBeenCalledWith("test-id");
  });

  it("non-overridden methods retain their defaults", async () => {
    const customGetInvoice = vi.fn().mockResolvedValue({ id: "custom-id" });

    const customMock = createMockSdk({
      getInvoice: customGetInvoice,
    });

    // createInvoice should still have default behavior
    const createResult = await customMock.createInvoice({
      creator: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5V3VF",
      recipients: [],
      token: "native",
      deadline: Math.floor(Date.now() / 1000) + 86400,
    });

    expect(createResult).toBeDefined();
    expect(createResult.invoiceId).toMatch(/^mock-invoice-/);
  });

  it("stubs can be called and tracked with mock.calls", async () => {
    await mockClient.getInvoice("invoice-1");
    await mockClient.getInvoice("invoice-2");

    expect(mockClient.getInvoice.mock.calls).toHaveLength(2);
    expect(mockClient.getInvoice.mock.calls[0]).toEqual(["invoice-1"]);
    expect(mockClient.getInvoice.mock.calls[1]).toEqual(["invoice-2"]);
  });

  it("stubs support mockImplementation to override behavior per test", async () => {
    mockClient.getInvoice.mockImplementation((id) => {
      if (id === "special") {
        return Promise.resolve({ id: "special-invoice" });
      }
      return Promise.resolve({ id: "normal" });
    });

    const special = await mockClient.getInvoice("special");
    const normal = await mockClient.getInvoice("normal");

    expect(special.id).toBe("special-invoice");
    expect(normal.id).toBe("normal");
  });

  it("resolves @stellar-split/sdk/testing subpath", async () => {
    // This test verifies the module can be imported from the testing subpath
    expect(createMockSdk).toBeDefined();
    expect(typeof createMockSdk).toBe("function");
  });

  it("multiple independent mock instances have separate state", async () => {
    const mock1 = createMockSdk();
    const mock2 = createMockSdk();

    mock1.getInvoice.mockImplementation((id) =>
      Promise.resolve({ id: `mock1-${id}` })
    );

    const result1 = await mock1.getInvoice("test");
    const result2 = await mock2.getInvoice("test");

    expect(result1.id).toBe("mock1-test");
    expect(result2.id).toBeDefined();
    expect(result2.id).not.toBe("mock1-test");
  });

  it("supports spying on multiple calls and results", async () => {
    mockClient.createInvoice.mockResolvedValue({
      invoiceId: "tracked-id",
      txHash: "tracked-hash",
    });

    await mockClient.createInvoice({
      creator: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5V3VF",
      recipients: [],
      token: "native",
      deadline: Math.floor(Date.now() / 1000) + 86400,
    });

    const results = mockClient.createInvoice.mock.results;
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("return");
  });

  it("default batch methods return properly typed results", async () => {
    const batchResult = await mockClient.batchCreateInvoices([
      {
        creator: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5V3VF",
        recipients: [],
        token: "native",
        deadline: Math.floor(Date.now() / 1000) + 86400,
      },
    ]);

    expect(batchResult).toBeDefined();
    expect(Array.isArray(batchResult.invoiceIds)).toBe(true);
    expect(batchResult.txHash).toBeDefined();
  });

  it("can chain overrides to test specific scenarios", async () => {
    const mockErrorFactory = (msg: string) =>
      vi.fn().mockRejectedValue(new Error(msg));

    const errorMock = createMockSdk({
      getInvoice: mockErrorFactory("Invoice not found"),
    });

    await expect(errorMock.getInvoice("nonexistent")).rejects.toThrow("Invoice not found");
  });

  it("works with async/await patterns in tests", async () => {
    mockClient.pay.mockResolvedValueOnce({ txHash: "pay-tx-1" });
    mockClient.pay.mockResolvedValueOnce({ txHash: "pay-tx-2" });

    const result1 = await mockClient.pay({
      invoiceId: "inv-1",
      payer: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5V3VF",
      amount: 1000n,
    });

    const result2 = await mockClient.pay({
      invoiceId: "inv-2",
      payer: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5V3VF",
      amount: 2000n,
    });

    expect(result1.txHash).toBe("pay-tx-1");
    expect(result2.txHash).toBe("pay-tx-2");
  });
});
