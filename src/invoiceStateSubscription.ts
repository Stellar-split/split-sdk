/**
 * WebSocket-based real-time invoice state subscription client with filtering and automatic reconnection.
 */

import type { InvoiceStatus } from "./types.js";

export interface InvoiceStateUpdate {
  invoiceId: string;
  status: InvoiceStatus;
  previousStatus?: InvoiceStatus;
  funded: bigint;
  targetAmount?: bigint;
  recipients?: Array<{ address: string; amount: bigint }>;
  lastPayment?: {
    payer: string;
    amount: bigint;
    timestamp: number;
    txHash?: string;
  };
  timestamp: number;
  ledger?: number;
  metadata?: Record<string, unknown>;
}

export interface InvoiceStateFilter {
  /** Target invoice ID(s) or "*" for all. */
  invoiceId?: string | string[];
  /** Filter by lifecycle status. */
  status?: InvoiceStatus | InvoiceStatus[];
  /** Filter by invoice creator address. */
  creator?: string;
  /** Filter by latest payment payer address. */
  payer?: string;
  /** Filter by minimum funded amount in stroops. */
  minFunded?: bigint;
  /** Custom predicate filter. */
  custom?: (event: InvoiceStateUpdate) => boolean;
}

export interface ReconnectConfig {
  enabled?: boolean;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
}

export interface InvoiceStateSubscriberConfig {
  wsUrl?: string;
  rpcUrl?: string;
  wsFactory?: () => WebSocket;
  reconnect?: ReconnectConfig;
  heartbeatIntervalMs?: number;
}

export interface InvoiceStateSubscriptionHandle {
  readonly id: string;
  readonly filter: InvoiceStateFilter;
  readonly isActive: boolean;
  unsubscribe(): void;
  updateFilter(newFilter: Partial<InvoiceStateFilter>): void;
}

type SubscriberCallback = (event: InvoiceStateUpdate) => void;

interface ActiveSubscription {
  id: string;
  filter: InvoiceStateFilter;
  callback: SubscriberCallback;
  active: boolean;
}

function rpcToWsUrl(url: string): string {
  return url.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
}

/**
 * Evaluates whether an InvoiceStateUpdate matches the given InvoiceStateFilter.
 */
export function matchesFilter(
  event: InvoiceStateUpdate,
  filter?: InvoiceStateFilter,
): boolean {
  if (!filter) return true;

  // Filter by invoiceId
  if (filter.invoiceId !== undefined && filter.invoiceId !== "*") {
    if (Array.isArray(filter.invoiceId)) {
      if (!filter.invoiceId.includes(event.invoiceId)) return false;
    } else if (filter.invoiceId !== event.invoiceId) {
      return false;
    }
  }

  // Filter by status
  if (filter.status !== undefined) {
    if (Array.isArray(filter.status)) {
      if (!filter.status.includes(event.status)) return false;
    } else if (filter.status !== event.status) {
      return false;
    }
  }

  // Filter by creator
  if (filter.creator !== undefined) {
    const eventCreator = event.metadata?.creator as string | undefined;
    if (!eventCreator || eventCreator.toLowerCase() !== filter.creator.toLowerCase()) {
      return false;
    }
  }

  // Filter by payer
  if (filter.payer !== undefined) {
    const payer = event.lastPayment?.payer;
    if (!payer || payer.toLowerCase() !== filter.payer.toLowerCase()) {
      return false;
    }
  }

  // Filter by minFunded
  if (filter.minFunded !== undefined) {
    if (event.funded < filter.minFunded) {
      return false;
    }
  }

  // Filter by custom predicate
  if (filter.custom) {
    try {
      if (!filter.custom(event)) return false;
    } catch {
      return false;
    }
  }

  return true;
}

export class InvoiceStateSubscriber {
  private ws: WebSocket | null = null;
  private readonly wsUrl: string;
  private readonly wsFactory: () => WebSocket;
  private readonly reconnectConfig: Required<ReconnectConfig>;
  private readonly heartbeatIntervalMs: number;

  private connected = false;
  private stopped = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private readonly subscriptions = new Map<string, ActiveSubscription>();
  private nextSubId = 1;

  // Lifecycle listeners
  private readonly onConnectListeners = new Set<() => void>();
  private readonly onDisconnectListeners = new Set<(reason?: string) => void>();
  private readonly onReconnectListeners = new Set<(attempt: number, max: number) => void>();
  private readonly onReconnectFailedListeners = new Set<(attempts: number) => void>();
  private readonly onErrorListeners = new Set<(err: Error) => void>();

  constructor(config: InvoiceStateSubscriberConfig) {
    const url = config.wsUrl ?? (config.rpcUrl ? rpcToWsUrl(config.rpcUrl) : "ws://localhost:8000");
    this.wsUrl = url;

    this.wsFactory =
      config.wsFactory ??
      (() => {
        if (typeof WebSocket !== "undefined") {
          return new WebSocket(this.wsUrl);
        }
        throw new Error(
          "WebSocket is not available in this environment. Provide a custom wsFactory.",
        );
      });

    this.reconnectConfig = {
      enabled: config.reconnect?.enabled ?? true,
      maxAttempts: config.reconnect?.maxAttempts ?? 5,
      baseDelayMs: config.reconnect?.baseDelayMs ?? 1000,
      maxDelayMs: config.reconnect?.maxDelayMs ?? 30000,
      jitter: config.reconnect?.jitter ?? true,
    };

    this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? 30000;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get activeSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  /**
   * Subscribe to real-time invoice state updates with optional filter criteria.
   */
  subscribe(
    filter: InvoiceStateFilter | string,
    callback: SubscriberCallback,
  ): InvoiceStateSubscriptionHandle {
    const normalizedFilter: InvoiceStateFilter =
      typeof filter === "string" ? { invoiceId: filter } : { ...filter };

    const subId = `sub_${this.nextSubId++}`;
    const subRecord: ActiveSubscription = {
      id: subId,
      filter: normalizedFilter,
      callback,
      active: true,
    };

    this.subscriptions.set(subId, subRecord);

    if (this.connected && this.ws?.readyState === 1) {
      this.sendSubscriptionFilter(subRecord);
    } else if (!this.connected && this.ws === null && !this.stopped) {
      this.connect();
    }

    const handle: InvoiceStateSubscriptionHandle = {
      id: subId,
      get filter() {
        return { ...subRecord.filter };
      },
      get isActive() {
        return subRecord.active;
      },
      unsubscribe: () => {
        if (!subRecord.active) return;
        subRecord.active = false;
        this.subscriptions.delete(subId);
        if (this.connected && this.ws?.readyState === 1) {
          try {
            this.ws.send(JSON.stringify({ action: "unsubscribe", subscriptionId: subId }));
          } catch {
            // Ignore send failure on unsubscribe
          }
        }
        if (this.subscriptions.size === 0) {
          this.disconnect();
        }
      },
      updateFilter: (newFilter: Partial<InvoiceStateFilter>) => {
        if (!subRecord.active) return;
        subRecord.filter = { ...subRecord.filter, ...newFilter };
        if (this.connected && this.ws?.readyState === 1) {
          this.sendSubscriptionFilter(subRecord);
        }
      },
    };

    return handle;
  }

  // -------------------------------------------------------------------------
  // WebSocket Lifecycle & Connection Management
  // -------------------------------------------------------------------------

  connect(): void {
    if (this.stopped) return;
    if (this.connected || (this.ws && this.ws.readyState === 0)) return;

    try {
      this.ws = this.wsFactory();
    } catch (err) {
      this.handleSocketError(err instanceof Error ? err : new Error(String(err)));
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      this.startHeartbeat();

      // Resubscribe all active subscriptions
      for (const sub of this.subscriptions.values()) {
        if (sub.active) {
          this.sendSubscriptionFilter(sub);
        }
      }

      for (const cb of this.onConnectListeners) {
        try { cb(); } catch {}
      }
    };

    this.ws.onclose = (event) => {
      this.cleanupSocket();
      for (const cb of this.onDisconnectListeners) {
        try { cb(event.reason); } catch {}
      }
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.handleSocketError(new Error("WebSocket connection error"));
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(event.data);
    };
  }

  private sendSubscriptionFilter(sub: ActiveSubscription): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    try {
      this.ws.send(
        JSON.stringify({
          action: "subscribe",
          subscriptionId: sub.id,
          filter: {
            ...sub.filter,
            minFunded: sub.filter.minFunded?.toString(),
            custom: undefined, // Predicate runs client-side
          },
        }),
      );
    } catch {
      // Non-blocking socket write
    }
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== "string") return;

    try {
      const raw = JSON.parse(data) as Record<string, unknown>;
      // Skip server ack messages or heartbeat pongs
      if (raw.type === "pong" || raw.action === "ack") return;

      const update = this.normalizeInvoiceStateUpdate(raw);
      if (!update) return;

      // Dispatch to all matching subscriptions
      for (const sub of this.subscriptions.values()) {
        if (sub.active && matchesFilter(update, sub.filter)) {
          try {
            sub.callback(update);
          } catch {
            // Consumer handler error should not break event loop
          }
        }
      }
    } catch {
      // Malformed json message
    }
  }

  private normalizeInvoiceStateUpdate(raw: Record<string, unknown>): InvoiceStateUpdate | null {
    const invoiceId = (raw.invoiceId as string) || (raw.id as string);
    const status = (raw.status as InvoiceStatus) || "Pending";
    if (!invoiceId) return null;

    let funded = 0n;
    if (typeof raw.funded === "bigint") {
      funded = raw.funded;
    } else if (typeof raw.funded === "number") {
      funded = BigInt(Math.floor(raw.funded));
    } else if (typeof raw.funded === "string") {
      try { funded = BigInt(raw.funded); } catch { funded = 0n; }
    }

    let targetAmount: bigint | undefined;
    if (typeof raw.targetAmount === "bigint") {
      targetAmount = raw.targetAmount;
    } else if (typeof raw.targetAmount === "string") {
      try { targetAmount = BigInt(raw.targetAmount); } catch { targetAmount = undefined; }
    }

    return {
      invoiceId,
      status,
      previousStatus: (raw.previousStatus as InvoiceStatus) || undefined,
      funded,
      targetAmount,
      recipients: Array.isArray(raw.recipients)
        ? raw.recipients.map((r: { address: string; amount: unknown }) => ({
            address: r.address,
            amount: typeof r.amount === "bigint" ? r.amount : BigInt(String(r.amount || 0)),
          }))
        : undefined,
      lastPayment: raw.lastPayment
        ? {
            payer: (raw.lastPayment as { payer: string }).payer,
            amount: BigInt(String((raw.lastPayment as { amount: unknown }).amount || 0)),
            timestamp: Number((raw.lastPayment as { timestamp: unknown }).timestamp || Date.now()),
            txHash: (raw.lastPayment as { txHash?: string }).txHash,
          }
        : undefined,
      timestamp: Number(raw.timestamp || Date.now()),
      ledger: typeof raw.ledger === "number" ? raw.ledger : undefined,
      metadata: typeof raw.metadata === "object" && raw.metadata !== null ? (raw.metadata as Record<string, unknown>) : undefined,
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.reconnectConfig.enabled) return;

    this.reconnectAttempts++;
    if (this.reconnectAttempts > this.reconnectConfig.maxAttempts) {
      for (const cb of this.onReconnectFailedListeners) {
        try { cb(this.reconnectAttempts - 1); } catch {}
      }
      return;
    }

    let delay = Math.min(
      this.reconnectConfig.baseDelayMs * Math.pow(2, this.reconnectAttempts - 1),
      this.reconnectConfig.maxDelayMs,
    );

    if (this.reconnectConfig.jitter) {
      delay = Math.floor(delay * (0.8 + Math.random() * 0.4));
    }

    for (const cb of this.onReconnectListeners) {
      try { cb(this.reconnectAttempts, this.reconnectConfig.maxAttempts); } catch {}
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);

    if (typeof this.reconnectTimer === "object" && this.reconnectTimer !== null && "unref" in this.reconnectTimer) {
      (this.reconnectTimer as NodeJS.Timeout).unref();
    }
  }

  private handleSocketError(err: Error): void {
    for (const cb of this.onErrorListeners) {
      try { cb(err); } catch {}
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    if (this.heartbeatIntervalMs > 0) {
      this.heartbeatTimer = setInterval(() => {
        if (this.ws && this.ws.readyState === 1) {
          try {
            this.ws.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
          } catch {
            // Heartbeat send failed
          }
        }
      }, this.heartbeatIntervalMs);

      if (typeof this.heartbeatTimer === "object" && this.heartbeatTimer !== null && "unref" in this.heartbeatTimer) {
        (this.heartbeatTimer as NodeJS.Timeout).unref();
      }
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private cleanupSocket(): void {
    this.connected = false;
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      try {
        if (this.ws.readyState === 0 || this.ws.readyState === 1) {
          this.ws.close();
        }
      } catch {
        // Ignore close error
      }
      this.ws = null;
    }
  }

  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.cleanupSocket();
  }

  /**
   * Remove all subscriptions, clear timers, and tear down the socket.
   * After destroy the subscriber cannot be reused.
   */
  destroy(): void {
    for (const sub of this.subscriptions.values()) {
      sub.active = false;
    }
    this.subscriptions.clear();
    this.disconnect();
    this.onConnectListeners.clear();
    this.onDisconnectListeners.clear();
    this.onReconnectListeners.clear();
    this.onReconnectFailedListeners.clear();
    this.onErrorListeners.clear();
  }

  // -------------------------------------------------------------------------
  // Event Emitter Helpers
  // -------------------------------------------------------------------------

  on(event: "connect", cb: () => void): this;
  on(event: "disconnect", cb: (reason?: string) => void): this;
  on(event: "reconnect", cb: (attempt: number, max: number) => void): this;
  on(event: "reconnect_failed", cb: (attempts: number) => void): this;
  on(event: "error", cb: (err: Error) => void): this;
  on(event: string, cb: (...args: any[]) => void): this {
    switch (event) {
      case "connect":
        this.onConnectListeners.add(cb as () => void);
        break;
      case "disconnect":
        this.onDisconnectListeners.add(cb as (reason?: string) => void);
        break;
      case "reconnect":
        this.onReconnectListeners.add(cb as (attempt: number, max: number) => void);
        break;
      case "reconnect_failed":
        this.onReconnectFailedListeners.add(cb as (attempts: number) => void);
        break;
      case "error":
        this.onErrorListeners.add(cb as (err: Error) => void);
        break;
    }
    return this;
  }

  off(event: string, cb: (...args: any[]) => void): this {
    switch (event) {
      case "connect":
        this.onConnectListeners.delete(cb as () => void);
        break;
      case "disconnect":
        this.onDisconnectListeners.delete(cb as (reason?: string) => void);
        break;
      case "reconnect":
        this.onReconnectListeners.delete(cb as (attempt: number, max: number) => void);
        break;
      case "reconnect_failed":
        this.onReconnectFailedListeners.delete(cb as (attempts: number) => void);
        break;
      case "error":
        this.onErrorListeners.delete(cb as (err: Error) => void);
        break;
    }
    return this;
  }
}

/**
 * Manages a set of named handlers over an InvoiceStateSubscriber, tracking
 * handler ids so they can be removed individually or all at once.
 */
export class SubscriptionManager {
  private readonly subscriber: InvoiceStateSubscriber;
  private readonly handlers = new Map<string, InvoiceStateSubscriptionHandle>();
  private nextHandlerId = 1;

  constructor(subscriber: InvoiceStateSubscriber) {
    this.subscriber = subscriber;
  }

  get size(): number {
    return this.handlers.size;
  }

  subscribe(
    filter: InvoiceStateFilter | string,
    callback: SubscriberCallback,
  ): string {
    const handle = this.subscriber.subscribe(filter, callback);
    const handlerId = `handler_${this.nextHandlerId++}`;
    this.handlers.set(handlerId, handle);
    return handlerId;
  }

  removeHandler(handlerId: string): boolean {
    const handle = this.handlers.get(handlerId);
    if (!handle) return false;
    handle.unsubscribe();
    this.handlers.delete(handlerId);
    return true;
  }

  destroy(): void {
    for (const handle of this.handlers.values()) {
      handle.unsubscribe();
    }
    this.handlers.clear();
    this.subscriber.destroy();
  }
}
