export type TimelineEventType =
  | "invoice_created"
  | "payment_received"
  | "status_changed"
  | "recipient_added"
  | "recipient_rerouted"
  | "sla_breached";

export type TimelineSource = "soroban" | "horizon";

/**
 * Lifecycle status of a single timeline entry.
 * A string union (rather than a numeric enum) is used for clean JSON
 * serialisation — the values round-trip through JSON without conversion.
 */
export type TimelineEntryStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed";

export interface TimelineEntry {
  timestamp: number;
  ledger: number;
  type: TimelineEventType;
  /** Current lifecycle status of this entry. */
  status: TimelineEntryStatus;
  data: Record<string, unknown>;
  source: TimelineSource;
  txHash?: string;
}

export interface ReconstructedTimeline {
  entries: TimelineEntry[];
  totalEvents: number;
  sources: { soroban: number; horizon: number };
  deduplicatedCount: number;
}

export interface RebuildOptions {
  from?: number;
  to?: number;
  types?: TimelineEventType[];
}