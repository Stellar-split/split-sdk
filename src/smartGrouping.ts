import type { Invoice } from "./types.js";

export interface InvoiceCluster {
  label: string;
  invoices: Invoice[];
  similarity: number;
}

interface InvoiceGroupingKey {
  token: string;
  recipientSignature: string;
  memoPrefix: string;
  recurring: boolean;
}

function computeRecipientSignature(recipients: Invoice["recipients"]): string {
  return [...recipients]
    .map((recipient) => recipient.address)
    .sort()
    .join("|");
}

function computeMemoPrefix(memo?: string): string {
  if (!memo) {
    return "";
  }

  const normalized = memo.trim().toLowerCase();
  if (normalized.length === 0) {
    return "";
  }

  const prefix = normalized.split(/\s+/)[0] ?? "";
  return prefix;
}

function computeInvoiceAmount(invoice: Invoice): bigint {
  return invoice.recipients.reduce((total, recipient) => total + recipient.amount, 0n);
}

function amountsWithinTolerance(amountA: bigint, amountB: bigint, tolerance = 0.1): boolean {
  if (amountA === 0n && amountB === 0n) {
    return true;
  }

  const larger = amountA > amountB ? amountA : amountB;
  const diff = amountA > amountB ? amountA - amountB : amountB - amountA;

  return diff * 100n <= BigInt(Math.ceil(tolerance * 100)) * larger;
}

function buildClusterLabel(key: InvoiceGroupingKey): string {
  const recipients = key.recipientSignature ? key.recipientSignature.split("|").join(", ") : "(none)";
  const memoPart = key.memoPrefix ? `memo prefix "${key.memoPrefix}"` : "no memo prefix";
  const recurringPart = key.recurring ? "recurring" : "one-off";

  return `${recurringPart} ${key.token} invoices to ${recipients} with ${memoPart}`;
}

export function groupInvoicesByPattern(invoices: Invoice[]): InvoiceCluster[] {
  if (invoices.length === 0) {
    return [];
  }

  const buckets = new Map<string, Array<{ invoice: Invoice; amount: bigint }>>();

  for (const invoice of invoices) {
    const key: InvoiceGroupingKey = {
      token: invoice.token,
      recipientSignature: computeRecipientSignature(invoice.recipients),
      memoPrefix: computeMemoPrefix(invoice.memo),
      recurring: Boolean(invoice.recurring),
    };

    const bucketKey = `${key.token}::${key.recipientSignature}::${key.memoPrefix}::${key.recurring}`;
    const entry = buckets.get(bucketKey);
    const amount = computeInvoiceAmount(invoice);

    if (entry) {
      entry.push({ invoice, amount });
    } else {
      buckets.set(bucketKey, [{ invoice, amount }]);
    }
  }

  const clusters: InvoiceCluster[] = [];

  for (const [bucketKey, items] of buckets.entries()) {
    const [token = "", recipientSignature = "", memoPrefix = "", recurringString = ""] = bucketKey.split("::");
    const key: InvoiceGroupingKey = {
      token,
      recipientSignature,
      memoPrefix,
      recurring: recurringString === "true",
    };

    const sortedItems = [...items].sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0));
    const bucketClusters: Array<{ invoices: Invoice[]; amounts: bigint[] }> = [];

    for (const item of sortedItems) {
      const placed = bucketClusters.some((cluster) => {
        const representative = cluster.amounts[0] ?? 0n;
        if (amountsWithinTolerance(representative, item.amount)) {
          cluster.invoices.push(item.invoice);
          cluster.amounts.push(item.amount);
          return true;
        }
        return false;
      });

      if (!placed) {
        bucketClusters.push({ invoices: [item.invoice], amounts: [item.amount] });
      }
    }

    for (const cluster of bucketClusters) {
      const averageAmount = cluster.amounts.reduce((sum, value) => sum + value, 0n) / BigInt(cluster.amounts.length);
      const similarity = cluster.amounts.reduce((sum, value) => {
        const diff = value > averageAmount ? value - averageAmount : averageAmount - value;
        return sum + Number(diff) / Number(averageAmount === 0n ? 1n : averageAmount);
      }, 0) / cluster.amounts.length;
      const normalizedSimilarity = Math.max(0, 1 - similarity);

      clusters.push({
        label: buildClusterLabel(key),
        invoices: cluster.invoices,
        similarity: Number(normalizedSimilarity.toFixed(4)),
      });
    }
  }

  return clusters.sort((a, b) => {
    if (b.invoices.length !== a.invoices.length) {
      return b.invoices.length - a.invoices.length;
    }
    return b.similarity - a.similarity;
  });
}
