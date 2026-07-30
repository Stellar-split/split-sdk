/**
 * Soroban Contract Event Log Subscriber — Issue #544
 *
 * Abstracts the SorobanRpc.Server.getEvents() call into a reactive async
 * iterable that yields only new contract events since the last poll,
 * persisting the ledger cursor via src/cursorTracker.ts so that the
 * subscription resumes correctly after a restart.
 */

import { rpc as SorobanRpc, xdr } from "@stellar/stellar-sdk";
import {
  getDefaultCursorStore,
  buildCursorKey,
} from "./cursorTracker.js";
import type { CursorStore } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Filter criteria for subscribing to a contract's event stream. */
export interface ContractEventFilter {
  /** One or more Soroban contract IDs to watch. */
  contractIds: string[];
  /**
   * Optional topic filter segments. Each segment is matched against the
   * corresponding topic position in the emitted event.
   */
  topics?: string[][];
}

/** A parsed Soroban contract event yielded by the subscriber. */
export interface ParsedContractEvent {
  /** The raw ledger sequence this event was emitted on. */
  ledger: number;
  /** The emitting contract's ID. */
  contractId: string;
  /**
   * Decoded topic values.  Each element is the JavaScript representation
   * of the XDR ScVal (string, number, object, etc.).
   */
  topics: unknown[];
  /** Decoded event data value (the `value` field from the raw event). */
  data: unknown;
  /** Unique event ID returned by Horizon / the RPC node. */
  id: string;
  /** Paging token that can be used to resume from this position. */
  pagingToken: string;
}

/** Configuration for {@link ContractEventSubscriber}. */
export interface ContractEventSubscriberConfig {
  /** Soroban RPC server instance. */
  server: SorobanRpc.Server;
  /** Polling interval in milliseconds. Default: 5 000 ms. */
  pollIntervalMs?: number;
  /**
   * Ledger sequence to start from on the very first subscription (when no
   * cursor has been persisted yet).  Defaults to `0` which will start from
   * the oldest available ledger on the node.
   */
  startLedger?: number;
  /**
   * Cursor store for persisting the last-processed ledger sequence.
   * Defaults to the module-level default store from cursorTracker.ts.
   */
  cursorStore?: CursorStore;
  /**
   * Namespace used when building the cursor key.  Set this to something
   * unique per subscriber so multiple instances do not share state.
   * Default: `"contractEvents"`.
   */
  cursorNamespace?: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Reactive contract-event subscriber backed by periodic SorobanRPC polling.
 *
 * @example
 * ```ts
 * const subscriber = new ContractEventSubscriber({ server });
 * for await (const event of subscriber.subscribe(contractId, { contractIds: [contractId] })) {
 *   console.log(event.topics, event.data);
 * }
 * ```
 */
export class ContractEventSubscriber {
  private readonly server: SorobanRpc.Server;
  private readonly pollIntervalMs: number;
  private readonly startLedger: number;
  private readonly cursorStore: CursorStore;
  private readonly cursorNamespace: string;

  /** Set to `true` by `unsubscribe()` to stop the polling loop. */
  private _stopped = false;

  constructor(config: ContractEventSubscriberConfig) {
    this.server = config.server;
    this.pollIntervalMs = config.pollIntervalMs ?? 5_000;
    this.startLedger = config.startLedger ?? 0;
    this.cursorStore = config.cursorStore ?? getDefaultCursorStore();
    this.cursorNamespace = config.cursorNamespace ?? "contractEvents";
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Subscribe to new events emitted by `contractId` matching the given
   * `filter`.  Yields each new {@link ParsedContractEvent} as it arrives.
   *
   * The last-processed ledger sequence is persisted so that the subscription
   * resumes from the correct position after a restart.
   *
   * Call {@link unsubscribe} to stop the loop and free resources.
   *
   * @param contractId - The primary contract to subscribe to.
   * @param filter     - Additional filter criteria (contractIds, topics).
   */
  async *subscribe(
    contractId: string,
    filter: ContractEventFilter,
  ): AsyncIterableIterator<ParsedContractEvent> {
    this._stopped = false;

    // Load the persisted cursor, or fall back to the configured startLedger
    const cursorKey = buildCursorKey(this.cursorNamespace, contractId);
    const persisted = await this.cursorStore.load(cursorKey);
    let lastLedger: number = persisted !== null ? parseInt(persisted, 10) : this.startLedger;

    while (!this._stopped) {
      const newEvents = await this._poll(filter, lastLedger);

      for (const event of newEvents) {
        if (this._stopped) return;
        yield event;
        // Advance the cursor past this event's ledger
        if (event.ledger > lastLedger) {
          lastLedger = event.ledger;
        }
      }

      // Persist cursor after each successful poll cycle
      await this.cursorStore.save(cursorKey, String(lastLedger));

      if (!this._stopped) {
        await this._sleep(this.pollIntervalMs);
      }
    }
  }

  /**
   * Stop the polling loop.  Any currently-executing `for await` loop will
   * exit after the current batch of events has been yielded.
   */
  unsubscribe(): void {
    this._stopped = true;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Execute one poll cycle: call `getEvents` with `startLedger = lastLedger + 1`
   * and return only events newer than `lastLedger`.
   */
  private async _poll(
    filter: ContractEventFilter,
    lastLedger: number,
  ): Promise<ParsedContractEvent[]> {
    const startLedger = lastLedger === 0 ? 0 : lastLedger + 1;

    let response: SorobanRpc.Api.GetEventsResponse;
    try {
      response = await this.server.getEvents({
        startLedger,
        filters: [
          {
            type: "contract",
            contractIds: filter.contractIds,
            ...(filter.topics ? { topics: filter.topics } : {}),
          },
        ],
      });
    } catch {
      // Network / RPC errors are silently swallowed; the loop will retry on the
      // next interval.
      return [];
    }

    if (!response?.events?.length) return [];

    // Filter out any events already seen (ledger <= lastLedger)
    return response.events
      .filter((ev) => ev.ledger > lastLedger)
      .map(parseEvent);
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      // Poll the stopped flag at short intervals so we don't overshoot
      const check = setInterval(() => {
        if (this._stopped) {
          clearTimeout(timer);
          clearInterval(check);
          resolve();
        }
      }, Math.min(ms, 50));
      // Clean up the interval when the timer fires naturally
      setTimeout(() => clearInterval(check), ms + 10);
    });
  }
}

// ---------------------------------------------------------------------------
// XDR decoding helpers
// ---------------------------------------------------------------------------

/**
 * Decode a single `xdr.ScVal` into a plain JavaScript value.
 * Falls back to the raw base-64 string when decoding fails.
 */
function decodeScVal(raw: xdr.ScVal | string | unknown): unknown {
  if (typeof raw === "string") {
    try {
      const scVal = xdr.ScVal.fromXDR(raw, "base64");
      return scValToJs(scVal);
    } catch {
      return raw;
    }
  }
  if (raw instanceof xdr.ScVal) {
    return scValToJs(raw);
  }
  return raw;
}

/**
 * Convert an `xdr.ScVal` to a plain JavaScript value.
 */
function scValToJs(val: xdr.ScVal): unknown {
  switch (val.switch().name) {
    case "scvBool":
      return val.b();
    case "scvVoid":
      return null;
    case "scvU32":
      return val.u32();
    case "scvI32":
      return val.i32();
    case "scvU64":
      return val.u64().toString();
    case "scvI64":
      return val.i64().toString();
    case "scvString":
      return val.str().toString();
    case "scvSymbol":
      return val.sym().toString();
    case "scvBytes":
      return Buffer.from(val.bytes()).toString("hex");
    case "scvAddress": {
      const addr = val.address();
      try {
        return addr.toString();
      } catch {
        return addr;
      }
    }
    case "scvVec": {
      const items = val.vec();
      return items ? items.map(scValToJs) : [];
    }
    case "scvMap": {
      const map = val.map();
      if (!map) return {};
      const obj: Record<string, unknown> = {};
      for (const entry of map) {
        const k = scValToJs(entry.key());
        obj[String(k)] = scValToJs(entry.val());
      }
      return obj;
    }
    default:
      return val;
  }
}

/** Parse a raw `SorobanRpc.Api.EventResponse` into a {@link ParsedContractEvent}. */
function parseEvent(
  raw: SorobanRpc.Api.EventResponse,
): ParsedContractEvent {
  const topics = Array.isArray(raw.topic)
    ? raw.topic.map(decodeScVal)
    : [];

  const data = decodeScVal(raw.value);

  // contractId may come as { contractId: string } or as a plain string
  const rawAny = raw as unknown as Record<string, unknown>;
  const contractIdRaw = rawAny["contractId"] ?? rawAny["contract_id"] ?? "";
  const contractId =
    typeof contractIdRaw === "string"
      ? contractIdRaw
      : String(contractIdRaw);

  const pagingToken =
    typeof rawAny["pagingToken"] === "string"
      ? rawAny["pagingToken"]
      : typeof rawAny["paging_token"] === "string"
      ? (rawAny["paging_token"] as string)
      : "";

  return {
    id: raw.id,
    ledger: raw.ledger,
    contractId,
    topics,
    data,
    pagingToken,
  };
}
