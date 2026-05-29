import type { Invoice, RevenueBreakdown } from "./types.js";

/** Minimal client interface needed for revenue calculation. */
interface RevenueClient {
  getInvoice(id: string): Promise<Invoice>;
}

/**
 * Compute protocol fee in stroops for a given gross amount and fee basis points.
 *
 * @param grossAmount - Total invoice amount in stroops.
 * @param feeBps      - Protocol fee in basis points (100 bps = 1%).
 */
export function calculateFee(grossAmount: bigint, feeBps: number): bigint {
  return (grossAmount * BigInt(feeBps)) / 10000n;
}

/**
 * Calculate net revenue breakdown for an invoice after protocol fees.
 *
 * @param invoiceId - The invoice ID to analyse.
 * @param client    - A client that can fetch invoices.
 * @param feeBps    - Protocol fee in basis points (default: 100 = 1%).
 * @returns Full revenue breakdown with per-recipient amounts.
 */
export async function calculateRevenue(
  invoiceId: string,
  client: RevenueClient,
  feeBps = 100
): Promise<RevenueBreakdown> {
  const invoice = await client.getInvoice(invoiceId);

  const gross = invoice.recipients.reduce((sum, r) => sum + r.amount, 0n);
  const protocolFee = calculateFee(gross, feeBps);
  const net = gross - protocolFee;

  const totalRecipientShare = gross === 0n ? 1n : gross;
  const perRecipient = invoice.recipients.map((r) => ({
    address: r.address,
    amount: (r.amount * net) / totalRecipientShare,
  }));

  return { invoiceId, gross, protocolFee, net, perRecipient };
}
