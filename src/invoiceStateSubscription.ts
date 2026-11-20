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

export interface InvoiceStateSubscriptionStats {
  /** Number of currently active subscriptions. */
  activeSubscriptions: number;
  /** Total number of subscriptions created since construction. */
  totalSubscriptions: number;
  /** Total number of updates delivered to subscriber callbacks. */
  updatesDelivered: number;
  /** Total number of updates received from the server (before filtering). */
  updatesReceived: number;
  /** Number of successful (re)connections. */
  reconnects: number;
  /** Number of state-change events detected (status transitions). */
  stateChanges: number;
  /** Number of updates replayed after a reconnect. */
  replayed: number;
  /** Whether the underlying socket is currently connected. */
  connected: boolean;
}

type SubscriberCallback = (event: InvoiceStateUpdate) => void;

interface ActiveSubscription {
  id: string;
  filter: InvoiceStateFilter;
  callback: SubscriberCallback;
  active: boolean;
  /** Last known state per invoice, used for change detection and replay. */
  lastSeen: Map<string, InvoiceStateUpdate>;
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

  // Statistics
  private totalSubscriptions = 0;
  private updatesDelivered = 0;
  private updatesReceived = 0;
  private reconnectCount = 0;
  private stateChangeCount = 0;
  private replayedCount = 0;

  // Replay buffer: recent updates retained across reconnects to avoid missed updates.
  private readonly replayBuffer: InvoiceStateUpdate[] = [];
  private readonly replayBufferLimit = 256;
  private hasConnectedOnce = false;

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
   * Returns a snapshot of subscription statistics.
   */
  getStats(): InvoiceStateSubscriptionStats {
    return {
      activeSubscriptions: this.subscriptions.size,
      totalSubscriptions: this.totalSubscriptions,
      updatesDelivered: this.updatesDelivered,
      updatesReceived: this.updatesReceived,
      reconnects: this.reconnectCount,
      stateChanges: this.stateChangeCount,
      replayed: this.replayedCount,
      connected: this.connected,
    };
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
      lastSeen: new Map(),
    };

    this.subscriptions.set(subId, subRecord);
    this.totalSubscriptions++;

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
      const isReconnect = this.hasConnectedOnce;
      this.connected = true;
      this.reconnectAttempts = 0;
      this.startHeartbeat();

      if (isReconnect) {
        this.reconnectCount++;
      }
      this.hasConnectedOnce = true;

      // Resubscribe all active subscriptions
      for (const sub of this.subscriptions.values()) {
        if (sub.active) {
          this.sendSubscriptionFilter(sub);
        }
      }

      // Replay buffered updates so no updates are missed across reconnects.
      if (isReconnect) {
        this.replayBufferedUpdates();
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

      this.updatesReceived++;
      this.bufferUpdate(update);
      this.dispatchUpdate(update);
    } catch {
      // Malformed json message
    }
  }

  /**
   * Detects whether an update represents a state change for a given subscription.
   * A change occurs when the status transitions or the funded amount increases.
   */
  private detectStateChange(
    sub: ActiveSubscription,
    update: InvoiceStateUpdate,
  ): boolean {
    const previous = sub.lastSeen.get(update.invoiceId);
    if (!previous) return false;
    if (previous.status !== update.status) return true;
    if (update.funded !== previous.funded) return true;
    return false;
  }

  /**
   * Dispatches an update to all matching active subscriptions, applying
   * change detection and updating per-subscription last-seen state.
   */
  private dispatchUpdate(update: InvoiceStateUpdate): void {
    for (const sub of this.subscriptions.values()) {
      if (!sub.active) continue;
      if (!matchesFilter(update, sub.filter)) continue;

      const changed = this.detectStateChange(sub, update);
      if (changed) {
        this.stateChangeCount++;
        if (update.previousStatus === undefined) {
          const previous = sub.lastSeen.get(update.invoiceId);
          if (previous) {
            update = { ...update, previousStatus: previous.status };
          }
        }
      }

      sub.lastSeen.set(update.invoiceId, update);

      try {
        sub.callback(update);
        this.updatesDelivered++;
      } catch {
        // Consumer handler error should not break event loop
      }
    }
  }

  private bufferUpdate(update: InvoiceStateUpdate): void {
    this.replayBuffer.push(update);
    if (this.replayBuffer.length > this.replayBufferLimit) {
      this.replayBuffer.shift();
    }
  }

  /**
   * Replays buffered updates after a reconnect, delivering only updates that
   * are newer than what each subscription has already seen.
   */
  private replayBufferedUpdates(): void {
    if (this.replayBuffer.length === 0) return;
    const buffered = this.replayBuffer.slice();
    for (const update of buffered) {
      for (const sub of this.subscriptions.values()) {
        if (!sub.active) continue;
        if (!matchesFilter(update, sub.filter)) continue;
        const previous = sub.lastSeen.get(update.invoiceId);
        if (previous && previous.timestamp >= update.timestamp) continue;
        sub.lastSeen.set(update.invoiceId, update);
        try {
          sub.callback(update);
          this.updatesDelivered++;
          this.replayedCount++;
        } catch {
          // Consumer handler error should not break event loop
        }
      }
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
   * Resets statistics counters. Useful for tests and long-running monitoring.
   */
  resetStats(): void {
    this.totalSubscriptions = this.subscriptions.size;
    this.updatesDelivered = 0;
    this.updatesReceived = 0;
    this.reconnectCount = 0;
    this.stateChangeCount = 0;
    this.replayedCount = 0;
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
}
