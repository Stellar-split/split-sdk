import type { Invoice, Recipient } from "./types.js";
import { InvoiceFlowFetcherNotRegisteredError } from "./errors.js";

export type InvoiceFlowFetcher = (invoiceId: string) => Promise<Invoice>;

let invoiceFlowFetcher: InvoiceFlowFetcher | null = null;

export function registerInvoiceFlowFetcher(fetcher: InvoiceFlowFetcher): void {
  invoiceFlowFetcher = fetcher;
}

function nodeId(prefix: string, value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_]/g, "_");
  return `${prefix}_${normalized || "node"}`;
}

function nodeLabel(value: string): string {
  return value.replace(/"/g, '\\"');
}

function amountLabel(value: bigint): string {
  return value.toString();
}

function allocatePayments(recipients: Recipient[], funded: bigint): Map<string, bigint> {
  let remaining = funded;
  const allocations = new Map<string, bigint>();

  for (const recipient of recipients) {
    const paid = remaining >= recipient.amount ? recipient.amount : remaining > 0n ? remaining : 0n;
    allocations.set(recipient.address, paid);
    remaining -= paid;
  }

  return allocations;
}

export async function generateFlowDiagram(
  invoiceId: string,
  getInvoice?: InvoiceFlowFetcher
): Promise<string> {
  const fetcher = getInvoice ?? invoiceFlowFetcher;
  if (!fetcher) {
    throw new InvoiceFlowFetcherNotRegisteredError();
  }

  const invoice = await fetcher(invoiceId);
  const creatorId = nodeId("creator", invoice.creator);
  const invoiceNodeId = nodeId("invoice", invoice.id);
  const totalPaid = invoice.payments.reduce((sum, payment) => sum + payment.amount, 0n);
  const funded = totalPaid > invoice.funded ? totalPaid : invoice.funded;
  const allocations = allocatePayments(invoice.recipients, funded);
  const lines = [
    "flowchart LR",
    `  ${creatorId}["Creator: ${nodeLabel(invoice.creator)}"]`,
    `  ${invoiceNodeId}["Invoice ${nodeLabel(invoice.id)}"]`,
    `  ${creatorId} --> ${invoiceNodeId}`,
  ];

  const completedNodes: string[] = [];
  const pendingNodes: string[] = [];

  for (const [index, recipient] of invoice.recipients.entries()) {
    const recipientId = nodeId(`recipient_${index + 1}`, recipient.address);
    const paid = allocations.get(recipient.address) ?? 0n;
    const className = paid >= recipient.amount ? "completed" : "pending";
    lines.push(`  ${recipientId}["Recipient ${index + 1}: ${nodeLabel(recipient.address)}"]`);
    lines.push(`  ${invoiceNodeId} -->|"${amountLabel(paid)} / ${amountLabel(recipient.amount)}"| ${recipientId}`);

    if (className === "completed") {
      completedNodes.push(recipientId);
    } else {
      pendingNodes.push(recipientId);
    }
  }

  lines.push("  classDef completed fill:#d1fae5,stroke:#047857,color:#064e3b");
  lines.push("  classDef pending fill:#fef3c7,stroke:#b45309,color:#78350f");

  if (completedNodes.length > 0) {
    lines.push(`  class ${completedNodes.join(",")} completed`);
  }
  if (pendingNodes.length > 0) {
    lines.push(`  class ${pendingNodes.join(",")} pending`);
  }

  return lines.join("\n");
}
