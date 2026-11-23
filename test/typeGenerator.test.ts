import { describe, it, expect } from "vitest";
import { TypeGenerator } from "../src/typeGenerator.js";

const schema = {
  type: "object" as const,
  description: "An invoice",
  required: ["id"],
  properties: {
    id: { type: "string" as const },
    amount: { type: "integer" as const },
    status: { enum: ["open", "paid"] },
    tags: { type: "array" as const, items: { type: "string" as const } },
  },
};

describe("TypeGenerator", () => {
  it("generates ts, dts and json output and tracks history", () => {
    const g = new TypeGenerator();
    const ts = g.generate("Invoice", schema);
    expect(ts).toContain("/** An invoice */");
    expect(ts).toContain("export interface Invoice {");
    expect(ts).toContain('"id": string;');
    expect(ts).toContain('"amount"?: number;');
    expect(ts).toContain('"status"?: "open" | "paid";');
    expect(g.generate("Invoice", schema, { format: "dts", useInterfaces: false })).toContain(
      "export declare type Invoice =",
    );
    expect(JSON.parse(g.generate("X", schema, { format: "json", nameTransform: (n) => n + "Dto" })).name).toBe("XDto");
    expect(g.getHistory().map((h) => h.format)).toEqual(["ts", "dts", "json"]);
  });
});
