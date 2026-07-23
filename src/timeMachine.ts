import type { HistoricalInvoice, Invoice } from "./types.js";
import { replayEvents } from "./events.js";
import type { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import { InvoiceNotFoundError } from "./errors.js";

export async function getInvoiceAtTime(
  server: SorobanRpc.Server,
  contractId: string,
  invoiceId: string,
  timestamp: number
): Promise<Invoice & HistoricalInvoice> {
  const events = await replayEvents(server, contractId, 0, Number.MAX_SAFE_INTEGER);
  const filtered = events
    .filter((e) => e.invoiceId === invoiceId && e.timestamp <= timestamp)
    .sort((a, b) => a.ledger - b.ledger);

  if (filtered.length === 0) {
    throw new InvoiceNotFoundError(invoiceId);
  }

  // Attempt to find a 'created' event to seed the invoice
  const created = filtered.find((e) => e.type === "created");
  if (!created) throw new InvoiceNotFoundError(invoiceId);

  // Assume created.data contains base invoice fields
  const base = created.data as Partial<Invoice>;
  const reconstructed: Invoice & HistoricalInvoice = {
    id: invoiceId,
    creator: (base.creator as string) ?? "",
    recipients: (base.recipients as Invoice["recipients"]) ?? [],
    token: (base.token as string) ?? "",
    deadline: (base.deadline as number) ?? 0,
    funded: 0n,
    status: (base.status as Invoice["status"]) ?? "Pending",
    payments: [],
    reconstructedAt: timestamp,
    // optional fields
    recurring: base.recurring,
    memo: base.memo,
    clonedFrom: base.clonedFrom,
    groupId: base.groupId,
    lastModifiedLedger: base.lastModifiedLedger,
    prerequisites: base.prerequisites,
  } as Invoice & HistoricalInvoice;

  for (const ev of filtered) {
    if (ev.type === "payment") {
      const pd = ev.data as any;
      const amount = typeof pd.amount === "bigint" ? pd.amount : BigInt(pd.amount ?? 0);
      const payment = {
        payer: pd.payer ?? "",
        amount,
        timestamp: ev.timestamp,
      };
      reconstructed.payments.push(payment);
      reconstructed.funded = reconstructed.funded + (payment.amount as bigint);
    } else if (ev.type === "released") {
      reconstructed.status = "Released";
    } else if (ev.type === "refunded") {
      reconstructed.status = "Refunded";
    }
  }

  return reconstructed;
}
