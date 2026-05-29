/**
 * Real-time invoice event streaming via Soroban RPC event polling.
 */

import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import type { InvoiceEventCallbacks, Payment } from "./types.js";

/**
 * Subscribe to live invoice events using Soroban RPC event polling.
 *
 * @param server      - Soroban RPC server instance
 * @param contractId  - The deployed StellarSplit contract ID
 * @param invoiceId   - The invoice ID to watch
 * @param callbacks   - Typed event callbacks
 * @param intervalMs  - Poll interval in milliseconds (default: 5000)
 * Polls for new contract events and fires typed callbacks when payments,
 * releases, or refunds are detected for the given invoice.
 *
 * @param server - Soroban RPC server instance
 * @param contractId - The deployed StellarSplit contract ID
 * @param invoiceId - The invoice ID to watch
 * @param callbacks - Typed event callbacks
 * @param intervalMs - Poll interval in milliseconds (default: 5000)
 * @returns Unsubscribe function that stops the stream
 */
export function subscribeToInvoice(
  server: SorobanRpc.Server,
  contractId: string,
  invoiceId: string,
  callbacks: InvoiceEventCallbacks,
  intervalMs: number = 5000
): () => void {
  let stopped = false;
  let lastLedger: number | null = null;

  const poll = async (): Promise<void> => {
    if (stopped) return;

    try {
      // On first poll, get the current ledger as our starting point
      if (lastLedger === null) {
        const latest = await server.getLatestLedger();
        lastLedger = latest.sequence;
      }

      const response = await server.getEvents({
        startLedger: lastLedger,
        filters: [{ type: "contract", contractIds: [contractId] }],
        filters: [
          {
            type: "contract",
            contractIds: [contractId],
          },
        ],
      });

      let maxLedger = lastLedger;

      for (const event of response.events) {
        if (event.ledger > maxLedger) maxLedger = event.ledger;
        if (event.ledger > maxLedger) {
          maxLedger = event.ledger;
        }

        const topic = event.topic as unknown[];
        if (!Array.isArray(topic) || topic.length === 0) continue;

        const eventType = typeof topic[0] === "string" ? topic[0] : null;
        if (!eventType) continue;

        // Filter to events for this invoice
        const eventInvoiceId = extractInvoiceId(event);
        if (eventInvoiceId !== invoiceId) continue;

        if (eventType === "payment" && callbacks.onPayment) {
          const payment = extractPayment(event);
          if (payment) callbacks.onPayment(payment);
        } else if (eventType === "released" && callbacks.onReleased) {
          callbacks.onReleased();
        } else if (eventType === "refunded" && callbacks.onRefunded) {
          callbacks.onRefunded();
        }
      }

      lastLedger = maxLedger + 1;
    } catch {
      // Silently continue on network errors
    }

    if (!stopped) setTimeout(poll, intervalMs);
  };

  poll();
  return () => { stopped = true; };
}

      // Advance past processed ledgers
      lastLedger = maxLedger + 1;
    } catch {
      // Silently continue on error — network hiccups shouldn't kill the stream
    }

    if (!stopped) {
      setTimeout(poll, intervalMs);
    }
  };

  poll();

  return () => {
    stopped = true;
  };
}

/** Extract invoice ID from a raw event. */
function extractInvoiceId(event: SorobanRpc.Api.EventResponse): string | null {
  const topic = event.topic as unknown[];
  if (Array.isArray(topic) && topic.length > 1) {
    const id = topic[1];
    if (typeof id === "string") return id;
    if (typeof id === "number" || typeof id === "bigint") return String(id);
  }

  const value = event.value as Record<string, unknown> | undefined;
  const id = value?.invoiceId;
  if (typeof id === "string") return id;
  if (typeof id === "number" || typeof id === "bigint") return String(id);
  return null;
}

function extractPayment(event: SorobanRpc.Api.EventResponse): Payment | null {
  const value = event.value as Record<string, unknown> | undefined;
  if (!value) return null;
  const { payer, amount } = value;
  if (typeof payer !== "string") return null;
  if (typeof amount !== "string" && typeof amount !== "number" && typeof amount !== "bigint") return null;
  return { payer, amount: BigInt(amount as string | number) };

  return null;
}

/** Extract a Payment from a payment event. */
function extractPayment(event: SorobanRpc.Api.EventResponse): Payment | null {
  const value = event.value as Record<string, unknown> | undefined;
  if (!value) return null;

  const payer = value.payer;
  const amount = value.amount;

  if (typeof payer !== "string") return null;
  if (typeof amount !== "string" && typeof amount !== "number" && typeof amount !== "bigint") return null;

  return {
    payer,
    amount: BigInt(amount as string | number),
  };
}
