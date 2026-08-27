import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import { TypedEventEmitter } from "./events/TypedEventEmitter.js";
import type { FinalityStatus } from "./types.js";

/** Event names emitted by Soroban contract activity during the invoice lifecycle. */
export type ContractEventType = "created" | "payment" | "released" | "refunded";

/** Normalized Soroban contract event payload returned by the SDK replay helpers. */
export interface ContractEvent {
  /** The contract event verb that was emitted on-chain. */
  type: ContractEventType;
  /** The invoice identifier extracted from the event body. */
  invoiceId: string;
  /** The raw event value emitted by the Soroban host. */
  data: unknown;
  /** The ledger sequence that included the event. */
  ledger: number;
  /** Unix timestamp, in seconds, inferred from the event metadata. */
  timestamp: number;
}

/** SDK-level events emitted as internal workflows progress. */
export interface SDKEventMap extends Record<string, unknown> {
  /** Emitted when a monitored stream has stopped producing data within the allowed interval. */
  streamStallDetected: { streamId: string };
  /** Emitted after the SDK automatically reconnects or resets a stalled stream. */
  streamAutoReset: { streamId: string };
  /** Emitted when a tracked invoice transaction reaches a finality state. */
  invoiceFinalized: { txHash: string; finality: FinalityStatus };
  /** Emitted when an approval workflow requests a signer response. */
  approvalRequested: { signerPublicKey: string };
  /** Emitted when a signer submits an approval for the workflow. */
  approvalReceived: { signerPublicKey: string };
  /** Emitted when the approval workflow reaches its required signer count. */
  approvalWorkflowComplete: { signerCount: number };
}

/** Shared typed emitter for SDK lifecycle events. */
export const sdkEvents = new TypedEventEmitter<SDKEventMap>();

/**
 * Emit a typed SDK lifecycle event to all registered listeners.
 *
 * @param event - The SDK event name to publish.
 * @param payload - The strongly typed payload associated with the event name.
 */
export function emitSdkEvent<K extends keyof SDKEventMap>(event: K, payload: SDKEventMap[K]): void {
  sdkEvents.emit(event, payload);
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

  const firstTopic: unknown = topic[0];
  const eventType = parseEventType(firstTopic);
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
