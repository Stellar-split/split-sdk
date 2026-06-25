import { createHash } from "crypto";
import type { ContractEvent } from "./events.js";

/**
 * Maintains a running SHA-256 chain hash over consumed events.
 *
 * Similar to auditLogger.ts but specific to on-chain event streams.
 * Creates an immutable chain where each event's hash depends on all
 * previous events, enabling detection of tampering or gaps.
 *
 * Chain hash formula:
 *   hash[i] = SHA256(prevHash || eventLedger || eventTopics || eventData)
 */
export class EventChecksumChain {
  private chainHash: string;
  private eventCount: number;

  /**
   * Creates a new checksum chain starting from genesis hash.
   */
  constructor() {
    // Genesis hash: SHA256 of empty string
    this.chainHash = createHash("sha256").update("").digest("hex");
    this.eventCount = 0;
  }

  /**
   * Append an event to the chain and return the new chain hash.
   *
   * @param event - The contract event to append
   * @returns The new chain hash after appending this event
   */
  append(event: ContractEvent): string {
    const eventData = this.serializeEvent(event);
    const input = this.chainHash + eventData;
    this.chainHash = createHash("sha256").update(input).digest("hex");
    this.eventCount++;
    return this.chainHash;
  }

  /**
   * Get the current chain hash without modifying the chain.
   *
   * @returns The current chain hash
   */
  getCurrentHash(): string {
    return this.chainHash;
  }

  /**
   * Get the number of events appended to this chain.
   *
   * @returns The event count
   */
  getEventCount(): number {
    return this.eventCount;
  }

  /**
   * Serialize an event into a deterministic string representation.
   * Uses replacer to ensure consistent ordering of all nested keys.
   *
   * @param event - The event to serialize
   * @returns Serialized event string
   */
  private serializeEvent(event: ContractEvent): string {
    const sortedReplacer = (_key: string, value: unknown): unknown => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>;
        const sorted: Record<string, unknown> = {};
        Object.keys(obj)
          .sort()
          .forEach((k) => {
            sorted[k] = obj[k];
          });
        return sorted;
      }
      return value;
    };

    return JSON.stringify(
      {
        type: event.type,
        invoiceId: event.invoiceId,
        ledger: event.ledger,
        timestamp: event.timestamp,
        data: event.data,
      },
      sortedReplacer
    );
  }
}

/**
 * Verify that a sequence of events produces the expected final hash.
 *
 * Recomputes the entire chain from scratch and confirms the final hash matches.
 * This detects:
 * - Tampered events (modified event data)
 * - Reordered events (same events but different sequence)
 * - Missing events (gaps in the chain)
 * - Extra events (spurious additions)
 *
 * @param events - Array of events to verify
 * @param expectedFinalHash - The expected final hash after processing all events
 * @returns true if the chain is valid, false otherwise
 */
export function verifyChain(
  events: ContractEvent[],
  expectedFinalHash: string
): boolean {
  const chain = new EventChecksumChain();

  for (const event of events) {
    chain.append(event);
  }

  return chain.getCurrentHash() === expectedFinalHash;
}

/**
 * Find the first tampered or reordered event in a sequence by comparing
 * against a known reference.
 *
 * Useful for debugging and pinpointing which event in the sequence is invalid.
 *
 * @param events - The events to check
 * @param referenceEvents - Reference events that produce the valid chain
 * @returns The index of the first mismatched event, or -1 if chain is valid
 */
export function findTamperedEvent(
  events: ContractEvent[],
  referenceEvents: ContractEvent[]
): number {
  // If lengths don't match, find where they diverge
  if (events.length !== referenceEvents.length) {
    const verificationChain = new EventChecksumChain();
    for (let i = 0; i < Math.min(events.length, referenceEvents.length); i++) {
      const currentEvent = events[i];
      if (currentEvent) {
        verificationChain.append(currentEvent);
      }

      const expectedChain = new EventChecksumChain();
      for (let j = 0; j <= i; j++) {
        const ref = referenceEvents[j];
        if (ref) {
          expectedChain.append(ref);
        }
      }

      if (verificationChain.getCurrentHash() !== expectedChain.getCurrentHash()) {
        return i;
      }
    }
    // If we got here, all matching events were identical; the divergence is at the length boundary
    return Math.min(events.length, referenceEvents.length);
  }

  // Lengths match; find the first mismatched event
  const verificationChain = new EventChecksumChain();
  for (let i = 0; i < events.length; i++) {
    const currentEvent = events[i];
    if (currentEvent) {
      verificationChain.append(currentEvent);
    }

    const expectedChain = new EventChecksumChain();
    for (let j = 0; j <= i; j++) {
      const ref = referenceEvents[j];
      if (ref) {
        expectedChain.append(ref);
      }
    }

    if (verificationChain.getCurrentHash() !== expectedChain.getCurrentHash()) {
      return i;
    }
  }

  return -1;
}
