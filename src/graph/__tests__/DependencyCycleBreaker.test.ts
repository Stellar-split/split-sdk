import { describe, it, expect, beforeEach } from "vitest";

interface InvoiceDependency {
  from: string;
  to: string;
  type: "predecessor" | "contingent";
}

interface Invoice {
  id: string;
  prerequisites?: string[];
}

interface CycleCheckResult {
  hasCycle: boolean;
  cycles: string[][];
  topologicalOrder?: string[];
}

class DependencyCycleError extends Error {
  cycles: string[][];

  constructor(cycles: string[][]) {
    super(`Invoice dependency cycles detected: ${JSON.stringify(cycles)}`);
    this.name = "DependencyCycleError";
    this.cycles = cycles;
  }
}

class DependencyCycleBreaker {
  private invoices: Map<string, Invoice> = new Map();
  private graph: Map<string, Set<string>> = new Map();
  private reverseGraph: Map<string, number> = new Map();

  check(invoices: Invoice[]): CycleCheckResult {
    this.buildGraph(invoices);
    const cycles = this.detectCycles();

    if (cycles.length > 0) {
      return {
        hasCycle: true,
        cycles,
      };
    }

    const topologicalOrder = this.kahnTopologicalSort();

    return {
      hasCycle: false,
      cycles: [],
      topologicalOrder,
    };
  }

  private buildGraph(invoices: Invoice[]): void {
    this.graph.clear();
    this.reverseGraph.clear();
    this.invoices.clear();

    for (const invoice of invoices) {
      this.invoices.set(invoice.id, invoice);
      this.graph.set(invoice.id, new Set());
      this.reverseGraph.set(invoice.id, 0);
    }

    for (const invoice of invoices) {
      if (invoice.prerequisites && invoice.prerequisites.length > 0) {
        for (const prereq of invoice.prerequisites) {
          if (this.graph.has(prereq)) {
            this.graph.get(prereq)!.add(invoice.id);
            this.reverseGraph.set(
              invoice.id,
              (this.reverseGraph.get(invoice.id) || 0) + 1
            );
          }
        }
      }
    }
  }

  private kahnTopologicalSort(): string[] {
    const inDegree = new Map(this.reverseGraph);
    const queue: string[] = [];

    for (const [node, degree] of inDegree) {
      if (degree === 0) {
        queue.push(node);
      }
    }

    const result: string[] = [];

    while (queue.length > 0) {
      const node = queue.shift()!;
      result.push(node);

      const neighbors = this.graph.get(node) || new Set();
      for (const neighbor of neighbors) {
        inDegree.set(neighbor, (inDegree.get(neighbor) || 1) - 1);
        if (inDegree.get(neighbor) === 0) {
          queue.push(neighbor);
        }
      }
    }

    return result;
  }

  private detectCycles(): string[][] {
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const recStack = new Set<string>();

    const dfs = (node: string, path: string[]): void => {
      visited.add(node);
      recStack.add(node);
      path.push(node);

      const neighbors = this.graph.get(node) || new Set();
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          dfs(neighbor, [...path]);
        } else if (recStack.has(neighbor)) {
          const cycleStart = path.indexOf(neighbor);
          const cycle = path.slice(cycleStart).concat([neighbor]);
          cycles.push(cycle);
        }
      }

      recStack.delete(node);
    };

    for (const node of this.graph.keys()) {
      if (!visited.has(node)) {
        dfs(node, []);
      }
    }

    return cycles;
  }
}

describe("DependencyCycleBreaker", () => {
  let breaker: DependencyCycleBreaker;

  beforeEach(() => {
    breaker = new DependencyCycleBreaker();
  });

  it("detects simple A → B → A cycle", () => {
    const invoices: Invoice[] = [
      { id: "inv-a", prerequisites: ["inv-b"] },
      { id: "inv-b", prerequisites: ["inv-a"] },
    ];

    const result = breaker.check(invoices);

    expect(result.hasCycle).toBe(true);
    expect(result.cycles.length).toBeGreaterThan(0);
    expect(result.cycles[0]).toContain("inv-a");
    expect(result.cycles[0]).toContain("inv-b");
  });

  it("detects longer cycle A → B → C → A", () => {
    const invoices: Invoice[] = [
      { id: "inv-a", prerequisites: ["inv-c"] },
      { id: "inv-b", prerequisites: ["inv-a"] },
      { id: "inv-c", prerequisites: ["inv-b"] },
    ];

    const result = breaker.check(invoices);

    expect(result.hasCycle).toBe(true);
    expect(result.cycles.length).toBeGreaterThan(0);
    expect(result.cycles[0]).toContain("inv-a");
    expect(result.cycles[0]).toContain("inv-b");
    expect(result.cycles[0]).toContain("inv-c");
  });

  it("accepts valid linear chain A → B → C", () => {
    const invoices: Invoice[] = [
      { id: "inv-a", prerequisites: [] },
      { id: "inv-b", prerequisites: ["inv-a"] },
      { id: "inv-c", prerequisites: ["inv-b"] },
    ];

    const result = breaker.check(invoices);

    expect(result.hasCycle).toBe(false);
    expect(result.cycles).toEqual([]);
  });

  it("returns topological order for acyclic graph", () => {
    const invoices: Invoice[] = [
      { id: "inv-a", prerequisites: [] },
      { id: "inv-b", prerequisites: ["inv-a"] },
      { id: "inv-c", prerequisites: ["inv-b"] },
    ];

    const result = breaker.check(invoices);

    expect(result.topologicalOrder).toBeDefined();
    expect(result.topologicalOrder).toContain("inv-a");
    expect(result.topologicalOrder).toContain("inv-b");
    expect(result.topologicalOrder).toContain("inv-c");

    const aIndex = result.topologicalOrder!.indexOf("inv-a");
    const bIndex = result.topologicalOrder!.indexOf("inv-b");
    const cIndex = result.topologicalOrder!.indexOf("inv-c");

    expect(aIndex).toBeLessThan(bIndex);
    expect(bIndex).toBeLessThan(cIndex);
  });

  it("handles disconnected subgraphs independently", () => {
    const invoices: Invoice[] = [
      { id: "inv-a", prerequisites: [] },
      { id: "inv-b", prerequisites: ["inv-a"] },
      { id: "inv-c", prerequisites: [] },
      { id: "inv-d", prerequisites: ["inv-c"] },
    ];

    const result = breaker.check(invoices);

    expect(result.hasCycle).toBe(false);
    expect(result.cycles).toEqual([]);
    expect(result.topologicalOrder?.length).toBe(4);
  });

  it("detects cycle in one subgraph while analyzing another", () => {
    const invoices: Invoice[] = [
      { id: "inv-a", prerequisites: [] },
      { id: "inv-b", prerequisites: ["inv-a"] },
      { id: "inv-c", prerequisites: ["inv-d"] },
      { id: "inv-d", prerequisites: ["inv-c"] },
    ];

    const result = breaker.check(invoices);

    expect(result.hasCycle).toBe(true);
    expect(result.cycles.length).toBeGreaterThan(0);
    expect(result.cycles[0]).toContain("inv-c");
    expect(result.cycles[0]).toContain("inv-d");
  });

  it("handles invoice with no prerequisites", () => {
    const invoices: Invoice[] = [
      { id: "inv-a" },
      { id: "inv-b", prerequisites: ["inv-a"] },
    ];

    const result = breaker.check(invoices);

    expect(result.hasCycle).toBe(false);
    expect(result.cycles).toEqual([]);
  });

  it("handles empty prerequisites array", () => {
    const invoices: Invoice[] = [
      { id: "inv-a", prerequisites: [] },
      { id: "inv-b", prerequisites: [] },
    ];

    const result = breaker.check(invoices);

    expect(result.hasCycle).toBe(false);
    expect(result.cycles).toEqual([]);
  });

  it("handles single invoice with no dependencies", () => {
    const invoices: Invoice[] = [{ id: "inv-a" }];

    const result = breaker.check(invoices);

    expect(result.hasCycle).toBe(false);
    expect(result.cycles).toEqual([]);
    expect(result.topologicalOrder).toEqual(["inv-a"]);
  });

  it("handles multiple independent invoices", () => {
    const invoices: Invoice[] = [
      { id: "inv-a" },
      { id: "inv-b" },
      { id: "inv-c" },
    ];

    const result = breaker.check(invoices);

    expect(result.hasCycle).toBe(false);
    expect(result.cycles).toEqual([]);
    expect(result.topologicalOrder?.length).toBe(3);
  });

  it("correctly identifies all members of a cycle", () => {
    const invoices: Invoice[] = [
      { id: "inv-a", prerequisites: ["inv-b", "inv-c"] },
      { id: "inv-b", prerequisites: ["inv-c"] },
      { id: "inv-c", prerequisites: ["inv-a"] },
    ];

    const result = breaker.check(invoices);

    expect(result.hasCycle).toBe(true);
    const cycle = result.cycles[0];
    expect(new Set(cycle)).toEqual(
      new Set(["inv-a", "inv-b", "inv-c", ...cycle.slice(-1)])
    );
  });

  it("handles fan-out dependencies", () => {
    const invoices: Invoice[] = [
      { id: "inv-a", prerequisites: [] },
      { id: "inv-b", prerequisites: ["inv-a"] },
      { id: "inv-c", prerequisites: ["inv-a"] },
      { id: "inv-d", prerequisites: ["inv-b", "inv-c"] },
    ];

    const result = breaker.check(invoices);

    expect(result.hasCycle).toBe(false);
    expect(result.topologicalOrder).toBeDefined();

    const aIndex = result.topologicalOrder!.indexOf("inv-a");
    const dIndex = result.topologicalOrder!.indexOf("inv-d");
    expect(aIndex).toBeLessThan(dIndex);
  });

  it("detects self-referencing cycle", () => {
    const invoices: Invoice[] = [{ id: "inv-a", prerequisites: ["inv-a"] }];

    const result = breaker.check(invoices);

    expect(result.hasCycle).toBe(true);
    expect(result.cycles[0]).toContain("inv-a");
  });

  it("handles prerequisites referring to non-existent invoices gracefully", () => {
    const invoices: Invoice[] = [
      { id: "inv-a", prerequisites: ["inv-nonexistent"] },
      { id: "inv-b" },
    ];

    const result = breaker.check(invoices);

    expect(result.hasCycle).toBe(false);
    expect(result.cycles).toEqual([]);
  });

  it("maintains cycle integrity across multiple calls", () => {
    const invoices: Invoice[] = [
      { id: "inv-a", prerequisites: ["inv-b"] },
      { id: "inv-b", prerequisites: ["inv-a"] },
    ];

    const result1 = breaker.check(invoices);
    const result2 = breaker.check(invoices);

    expect(result1.hasCycle).toBe(result2.hasCycle);
    expect(result1.cycles.length).toBe(result2.cycles.length);
  });
});
