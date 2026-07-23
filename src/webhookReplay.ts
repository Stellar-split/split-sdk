import type { WebhookEvent } from "./webhook.js";
import { StellarSplitError, isStellarSplitError } from "./errors.js";

export interface WebhookRecord {
  eventId: string;
  invoiceId: string;
  event: WebhookEvent;
  url: string;
  payload: unknown;
  firedAt: string;
}

export interface WebhookReplayStore {
  set(eventId: string, record: WebhookRecord): void;
  get(eventId: string): WebhookRecord | undefined;
}

const DEFAULT_BUFFER_SIZE = 100;

/** Thrown when a webhook event is not found in the replay store. */
export class WebhookEventNotFoundError extends StellarSplitError {
  readonly eventId: string;

  constructor(eventId: string, raw?: string) {
    super(`Webhook event not found: ${eventId}`, "WEBHOOK_EVENT_NOT_FOUND", { eventId }, raw);
    this.name = "WebhookEventNotFoundError";
    this.eventId = eventId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class RingBufferStore implements WebhookReplayStore {
  private readonly maxSize: number;
  private readonly map = new Map<string, WebhookRecord>();
  private readonly order: string[] = [];

  constructor(maxSize: number = DEFAULT_BUFFER_SIZE) {
    this.maxSize = maxSize;
  }

  set(eventId: string, record: WebhookRecord): void {
    if (this.map.has(eventId)) {
      this.map.set(eventId, record);
      return;
    }
    if (this.order.length >= this.maxSize) {
      const oldest = this.order.shift()!;
      this.map.delete(oldest);
    }
    this.order.push(eventId);
    this.map.set(eventId, record);
  }

  get(eventId: string): WebhookRecord | undefined {
    return this.map.get(eventId);
  }

  get size(): number {
    return this.map.size;
  }
}

let activeStore: WebhookReplayStore = new RingBufferStore();

export function configureReplayStore(store: WebhookReplayStore): void {
  activeStore = store;
}

let eventCounter = 0;

function generateEventId(): string {
  eventCounter += 1;
  return `evt_${eventCounter}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Records a fired webhook payload so it can be replayed later.
 * Called automatically by `recordAndTriggerWebhook`.
 */
export function recordWebhookEvent(
  invoiceId: string,
  event: WebhookEvent,
  url: string,
  payload: unknown,
): string {
  const eventId = generateEventId();
  const record: WebhookRecord = {
    eventId,
    invoiceId,
    event,
    url,
    payload,
    firedAt: new Date().toISOString(),
  };
  activeStore.set(eventId, record);
  return eventId;
}

/**
 * Re-sends the exact original payload for a previously fired webhook event.
 *
 * @param eventId - The event ID returned by `recordWebhookEvent`.
 * @throws If the event ID is not found in the replay store.
 */
export async function replayWebhook(eventId: string): Promise<void> {
  const record = activeStore.get(eventId);
  if (!record) {
    throw new WebhookEventNotFoundError(eventId);
  }

  await fetch(record.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(record.payload),
  });
}
