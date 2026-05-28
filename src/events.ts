import { rpc as SorobanRpc } from "@stellar/stellar-sdk";

/** Type of contract event. */
export type ContractEventType = "created" | "payment" | "released" | "refunded";

/** A Soroban contract event. */
export interface ContractEvent {
  /** Event type. */
  type: ContractEventType;
  /** Invoice ID associated with the event. */
  invoiceId: string;
  /** Event data. */
  data: unknown;
  /** Ledger sequence number. */
  ledger: number;
  /** Unix timestamp of the event. */
  timestamp: number;
}

/**
 * Replay historical contract events in a ledger range.
 *
 * @param server - Soroban RPC server
 * @param contractId - The contract ID to filter events
 * @param fromLedger - Starting ledger sequence
 * @param toLedger - Ending ledger sequence
 * @returns Array of contract events in chronological order
 */
export async function replayEvents(
  server: SorobanRpc.Server,
  contractId: string,
  fromLedger: number,
  toLedger: number
): Promise<ContractEvent[]> {
  const events: ContractEvent[] = [];

  try {
    const response = await server.getEvents({
      startLedger: fromLedger,
      filters: [
        {
          type: "contract",
          contractIds: [contractId],
        },
      ],
    });

    for (const event of response.events) {
      const contractEvent = parseContractEvent(event);
      if (contractEvent) {
        events.push(contractEvent);
      }
    }
  } catch (error) {
    console.error("Error replaying events:", error);
  }

  return events.sort((a, b) => a.ledger - b.ledger);
}

/** Parse a raw event into a typed ContractEvent. */
function parseContractEvent(
  event: SorobanRpc.Api.EventResponse
): ContractEvent | null {
  const topic = event.topic as unknown;
  if (!Array.isArray(topic) || topic.length === 0) return null;

  const eventType = parseEventType(topic[0] as unknown);
  if (!eventType) return null;

  const invoiceId = extractInvoiceId(event);
  if (!invoiceId) return null;

  const eventData = event as unknown as Record<string, unknown>;
  const createdAt = eventData.createdAt as string | undefined;
  const timestamp = createdAt
    ? Math.floor(new Date(createdAt).getTime() / 1000)
    : Math.floor(Date.now() / 1000);

  return {
    type: eventType,
    invoiceId,
    data: event.value,
    ledger: event.ledger,
    timestamp,
  };
}

/** Parse event type from topic. */
function parseEventType(topic: unknown): ContractEventType | null {
  if (typeof topic !== "string") return null;

  const typeMap: Record<string, ContractEventType> = {
    created: "created",
    payment: "payment",
    released: "released",
    refunded: "refunded",
  };

  return typeMap[topic] ?? null;
}

/** Extract invoice ID from event. */
function extractInvoiceId(event: SorobanRpc.Api.EventResponse): string | null {
  const value = event.value as unknown;
  if (typeof value === "string") return value;

  const valueObj = value as Record<string, unknown> | undefined;
  const id = valueObj?.invoiceId as unknown;
  if (typeof id === "string") return id;

  return null;
}
