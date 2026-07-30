import { rpc as SorobanRpc, Horizon } from "@stellar/stellar-sdk";
import { replayEvents } from "../events.js";
import type { ContractEvent } from "../events.js";
import type {
  TimelineEntry,
  TimelineEventType,
  ReconstructedTimeline,
  RebuildOptions,
} from "../types/timeline.js";

export interface PaymentTimelineReconstructorConfig {
  rpcUrl: string;
  contractId: string;
  networkPassphrase: string;
  horizonUrl?: string;
  server?: SorobanRpc.Server;
  horizonServer?: Horizon.Server;
}

const SOROBAN_EVENT_TYPE_MAP: Record<string, TimelineEventType> = {
  created: "invoice_created",
  payment: "payment_received",
  released: "status_changed",
  refunded: "status_changed",
  cancelled: "status_changed",
  frozen: "status_changed",
  unfrozen: "status_changed",
};

function computeEventType(event: ContractEvent): TimelineEventType {
  return SOROBAN_EVENT_TYPE_MAP[event.type] ?? "status_changed";
}

function dedupKey(entry: TimelineEntry): string {
  return `${entry.ledger}:${entry.txHash ?? ""}:${entry.type}`;
}

export class PaymentTimelineReconstructor {
  private readonly _server: SorobanRpc.Server;
  private readonly _contractId: string;
  private readonly _networkPassphrase: string;
  private readonly _horizonServer: Horizon.Server | null;

  constructor(config: PaymentTimelineReconstructorConfig) {
    this._server = config.server ?? new SorobanRpc.Server(config.rpcUrl);
    this._contractId = config.contractId;
    this._networkPassphrase = config.networkPassphrase;
    this._horizonServer =
      config.horizonServer ??
      (config.horizonUrl ? new Horizon.Server(config.horizonUrl) : null);
  }

  async rebuild(
    invoiceId: string,
    options?: RebuildOptions,
  ): Promise<ReconstructedTimeline> {
    const from = options?.from ?? 0;
    const to = options?.to ?? Number.MAX_SAFE_INTEGER;
    const typeFilter = options?.types;

    const sorobanEntries = await this._fetchSorobanEvents(invoiceId, from, to);
    const horizonEntries = this._horizonServer
      ? await this._fetchHorizonPayments(invoiceId, from, to)
      : [];

    const merged = [...sorobanEntries, ...horizonEntries];

    const { deduplicated, dedupCount } = this._deduplicate(merged);

    let filtered = deduplicated;
    if (typeFilter && typeFilter.length > 0) {
      filtered = filtered.filter((e) => typeFilter.includes(e.type));
    }

    filtered.sort((a, b) => {
      const tsDiff = a.timestamp - b.timestamp;
      if (tsDiff !== 0) return tsDiff;
      return a.ledger - b.ledger;
    });

    return {
      entries: filtered,
      totalEvents: filtered.length,
      sources: {
        soroban: sorobanEntries.length,
        horizon: horizonEntries.length,
      },
      deduplicatedCount: dedupCount,
    };
  }

  private async _fetchSorobanEvents(
    invoiceId: string,
    from: number,
    to: number,
  ): Promise<TimelineEntry[]> {
    const events = await replayEvents(this._server, this._contractId, from, to);

    return events
      .filter(
        (e) =>
          e.invoiceId === invoiceId &&
          e.ledger >= from &&
          e.ledger <= to,
      )
      .map((e) => {
        const rawData =
          typeof e.data === "object" && e.data !== null
            ? (e.data as Record<string, unknown>)
            : { value: e.data };

        const txHash =
          typeof rawData.txHash === "string" ? rawData.txHash : undefined;

        return {
          timestamp: e.timestamp,
          ledger: e.ledger,
          type: computeEventType(e),
          data: rawData,
          source: "soroban" as const,
          txHash,
        };
      });
  }

  private async _fetchHorizonPayments(
    invoiceId: string,
    from: number,
    to: number,
  ): Promise<TimelineEntry[]> {
    if (!this._horizonServer) return [];

    const entries: TimelineEntry[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 10; page++) {
      const raw = await this._horizonServer
        .operations()
        .forAccount(this._contractId)
        .limit(200)
        .cursor(cursor ?? "")
        .order("asc")
        .call();
      const response = raw as unknown as {
        records: Array<Record<string, unknown>>;
      };

      for (const op of response.records) {
        if (op.type !== "payment") continue;
        const ledger = Number(op.ledger ?? 0);
        if (ledger < from || ledger > to) continue;

        const memoInvoiceId = this._extractInvoiceId(op);
        if (memoInvoiceId !== invoiceId) continue;

        const created_at = op.created_at as string | undefined;
        entries.push({
          timestamp: created_at
            ? Math.floor(new Date(created_at).getTime() / 1000)
            : ledger,
          ledger,
          type: "payment_received",
          data: {
            paymentId: op.id,
            amount: op.amount,
            from: op.from,
            to: op.to,
            asset_type: op.asset_type,
          },
          source: "horizon",
          txHash: op.transaction_hash as string | undefined,
        });
      }

      if (response.records.length < 200) break;
      const lastOp = response.records[response.records.length - 1];
      if (lastOp) {
        cursor = lastOp.paging_token as string | undefined;
      }
    }

    return entries;
  }

  private _extractInvoiceId(
    payment: Record<string, unknown>,
  ): string | null {
    const memo = payment.memo;
    if (typeof memo === "string") {
      const match = memo.match(/invoice[:_]?(\d+)/i);
      if (match && match[1]) return match[1];
    }
    return null;
  }

  private _deduplicate(
    entries: TimelineEntry[],
  ): { deduplicated: TimelineEntry[]; dedupCount: number } {
    const seen = new Set<string>();
    const deduplicated: TimelineEntry[] = [];

    for (const entry of entries) {
      const key = dedupKey(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      deduplicated.push(entry);
    }

    return {
      deduplicated,
      dedupCount: entries.length - deduplicated.length,
    };
  }
}