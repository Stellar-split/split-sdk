export type TimelineEventType =
  | "invoice_created"
  | "payment_received"
  | "status_changed"
  | "recipient_added"
  | "recipient_rerouted"
  | "sla_breached";

export type TimelineSource = "soroban" | "horizon";

export interface TimelineEntry {
  timestamp: number;
  ledger: number;
  type: TimelineEventType;
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