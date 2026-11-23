import { describe, it, expect, vi } from "vitest";
import { StrKey } from "@stellar/stellar-sdk";
import {
  ContractInterfaceBuilder,
  createStellarSplitInterfaceBuilder,
} from "../src/contractInterfaceBuilder.js";

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 7));

describe("ContractInterfaceBuilder generation", () => {
  it("builds an invoke-contract operation that decodes to method and args", () => {
    const op = new ContractInterfaceBuilder(CONTRACT_ID)
      .method("pay")
      .param("invoice_id", 42)
      .param("note", "hello")
      .build();
    const decoded = ContractInterfaceBuilder.decode(op);
    expect(decoded.method).toBe("pay");
    expect(decoded.args).toEqual([42, "hello"]);
  });

  it("preserves bigint values accurately through encode/decode", () => {
    const big = 2n ** 70n;
    const op = new ContractInterfaceBuilder(CONTRACT_ID)
      .method("pay")
      .param("amount", big)
      .build();
    expect(ContractInterfaceBuilder.decode(op).args).toEqual([big]);
  });

  it("supports a method with no params", () => {
    const op = new ContractInterfaceBuilder(CONTRACT_ID).method("release").build();
    expect(ContractInterfaceBuilder.decode(op)).toEqual({ method: "release", args: [] });
  });

  it("resets method and params after build", () => {
    const b = new ContractInterfaceBuilder(CONTRACT_ID);
    b.method("pay").param("a", 1).build();
    expect(() => b.build()).toThrow(/no method selected/);
    expect(() => b.param("a", 1)).toThrow(/call \.method\(\)/);
  });

  it("method() discards previously added params", () => {
    const b = new ContractInterfaceBuilder(CONTRACT_ID);
    b.method("pay").param("a", 1);
    const op = b.method("refund").param("b", 2).build();
    expect(ContractInterfaceBuilder.decode(op)).toEqual({ method: "refund", args: [2] });
  });
});

describe("ContractInterfaceBuilder events and recording", () => {
  it("emits before:build and after:build with accurate payloads", () => {
    const b = new ContractInterfaceBuilder(CONTRACT_ID);
    const before = vi.fn();
    const after = vi.fn();
    b.on("before:build", before);
    b.on("after:build", after);
    const op = b.method("pay").param("x", 1).build();
    expect(before).toHaveBeenCalledWith({ method: "pay", params: [{ name: "x", value: 1 }] });
    expect(after).toHaveBeenCalledWith({ method: "pay", operation: op });
  });

  it("records operations only when record is true, and can clear them", () => {
    const b = new ContractInterfaceBuilder(CONTRACT_ID);
    b.method("pay").build();
    expect(b.getBuiltOperations()).toHaveLength(0);
    b.method("pay").build({ record: true });
    b.method("refund").build({ record: true });
    expect(b.getBuiltOperations()).toHaveLength(2);
    b.clearBuiltOperations();
    expect(b.getBuiltOperations()).toEqual([]);
  });
});

describe("ContractInterfaceBuilder spec customization", () => {
  it("registers, retrieves and overrides specs", () => {
    const b = new ContractInterfaceBuilder(CONTRACT_ID);
    b.registerSpec({ name: "m", params: [{ name: "a" }] });
    expect(b.getSpec("m")).toEqual({ name: "m", params: [{ name: "a" }] });
    b.registerSpec({ name: "m", description: "new", params: [] });
    expect(b.getSpec("m")?.description).toBe("new");
    expect(b.listSpecs()).toHaveLength(1);
    expect(b.getSpec("missing")).toBeUndefined();
  });

  it("createStellarSplitInterfaceBuilder pre-registers the contract methods", () => {
    const b = createStellarSplitInterfaceBuilder(CONTRACT_ID);
    expect(b.listSpecs().map((s) => s.name).sort()).toEqual(
      ["create_invoice", "pay", "refund", "release"],
    );
    expect(b.getSpec("pay")?.params.map((p) => p.name)).toEqual([
      "payer", "invoice_id", "amount",
    ]);
  });
});

describe("ContractInterfaceBuilder edge cases", () => {
  it("throws on an invalid contract id", () => {
    expect(() => new ContractInterfaceBuilder("not-a-contract")).toThrow();
  });
});
