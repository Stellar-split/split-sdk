import type { Invoice } from "./types.js";

export interface ValidationResult {
  valid: boolean;
  cycles: string[][];
  warnings: string[];
}

/**
 * Validate dependency graph built from Invoice.prerequisites.
 * Returns cycles (hard error) and dangling references (warnings).
 */
export function validateDependencyGraph(invoices: Invoice[]): ValidationResult {
  const ids = new Set(invoices.map((i) => i.id));
  // adjacency: id -> prerequisite ids that exist
  const adj = new Map<string, string[]>();
  const warnings: string[] = [];

  for (const inv of invoices) {
    const deps: string[] = [];
    for (const pre of inv.prerequisites ?? []) {
      if (!ids.has(pre)) {
        warnings.push(`Invoice "${inv.id}" references unknown prerequisite "${pre}"`);
      } else {
        deps.push(pre);
      }
    }
    adj.set(inv.id, deps);
  }

  const cycles: string[][] = [];
  const visited = new Set<string>();
  const onStack = new Set<string>();

  const dfs = (node: string, path: string[]): void => {
    visited.add(node);
    onStack.add(node);
    path.push(node);

    for (const neighbor of adj.get(node) ?? []) {
      if (!visited.has(neighbor)) {
        dfs(neighbor, path);
      } else if (onStack.has(neighbor)) {
        // Extract cycle from path
        const idx = path.indexOf(neighbor);
        cycles.push(path.slice(idx));
      }
    }

    path.pop();
    onStack.delete(node);
  };

  for (const id of ids) {
    if (!visited.has(id)) dfs(id, []);
  }

  return { valid: cycles.length === 0, cycles, warnings };
}
