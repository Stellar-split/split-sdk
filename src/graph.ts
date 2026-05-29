import { getIndexedInvoices } from "./searchEngine.js";

export interface InvoiceNode {
  invoiceId: string;
  clonedFrom?: string;
  groupId?: string;
}

export interface InvoiceGraph {
  nodes: InvoiceNode[];
  edges: Array<{ from: string; to: string; type: "clone" | "group" }>;
}

export async function buildInvoiceGraph(address: string): Promise<InvoiceGraph> {
  const all = getIndexedInvoices();
  const relevant = all.filter(
    (inv) =>
      inv.creator === address ||
      inv.recipients.some((r) => r.address === address)
  );

  const nodes: InvoiceNode[] = relevant.map((inv) => {
    const node: InvoiceNode = { invoiceId: inv.id };
    if (inv.clonedFrom !== undefined) node.clonedFrom = inv.clonedFrom;
    if (inv.groupId !== undefined) node.groupId = inv.groupId;
    return node;
  });

  const edges: Array<{ from: string; to: string; type: "clone" | "group" }> = [];

  for (const inv of relevant) {
    if (inv.clonedFrom !== undefined) {
      edges.push({ from: inv.clonedFrom, to: inv.id, type: "clone" });
    }
    if (inv.groupId !== undefined) {
      edges.push({ from: inv.id, to: inv.groupId, type: "group" });
    }
  }

  return { nodes, edges };
}
