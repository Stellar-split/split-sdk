import { describe, it, expect } from "vitest";
import { validateDependencyGraph } from "../src/dependencyGraphValidator.js";
import type { Invoice } from "../src/types.js";

function inv(id: string, prerequisites: string[] = []): Invoice {
  return {
    id,
    creator: "G_CREATOR",
    recipients: [],
    token: "USDC",
    deadline: 9999999999,
    funded: 0n,
    status: "Pending",
    payments: [],
    prerequisites,
  };
}

describe("validateDependencyGraph", () => {
  it("returns valid for an acyclic graph", () => {
    // A -> B -> C (A depends on B, B depends on C)
    const result = validateDependencyGraph([inv("A", ["B"]), inv("B", ["C"]), inv("C")]);
    expect(result.valid).toBe(true);
    expect(result.cycles).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("detects a direct self-cycle (A -> A)", () => {
    const result = validateDependencyGraph([inv("A", ["A"])]);
    expect(result.valid).toBe(false);
    expect(result.cycles.length).toBeGreaterThan(0);
    expect(result.cycles[0]).toContain("A");
  });

  it("detects an indirect cycle (A -> B -> A)", () => {
    const result = validateDependencyGraph([inv("A", ["B"]), inv("B", ["A"])]);
    expect(result.valid).toBe(false);
    expect(result.cycles.length).toBeGreaterThan(0);
    const flat = result.cycles.flat();
    expect(flat).toContain("A");
    expect(flat).toContain("B");
  });

  it("warns on dangling prerequisite references without failing", () => {
    const result = validateDependencyGraph([inv("A", ["MISSING"])]);
    expect(result.valid).toBe(true);
    expect(result.cycles).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/MISSING/);
  });

  it("handles invoices with no prerequisites", () => {
    const result = validateDependencyGraph([inv("X"), inv("Y"), inv("Z")]);
    expect(result.valid).toBe(true);
    expect(result.cycles).toHaveLength(0);
  });
});
