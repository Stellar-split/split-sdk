export type TransportType = 'websocket' | 'http';

export interface TransportStatus {
  type: TransportType;
  connected: boolean;
  reconnectAttempts: number;
}

export interface TransportEventMap {
  'transport:fallback': { from: 'websocket'; to: 'http'; invoiceId: string };
  'transport:connected': { type: 'websocket' };
  'transport:disconnected': { type: 'websocket'; reason?: string };
  'transport:reconnecting': { attempt: number; maxAttempts: number };
}

export type TransportFallbackCallback = (event: { from: 'websocket'; to: 'http' }) => void;

interface PendingSubscription {
  invoiceId: string;
  handler: (event: unknown) => void;
}

const WS_RECONNECT_BASE_MS = 1000;
const WS_RECONNECT_MAX_MS = 30_000;
const WS_MAX_RECONNECT_ATTEMPTS = 3;

function rpcUrlToWsUrl(rpcUrl: string): string {
  return rpcUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
}

export class WebSocketTransport {
  private _ws: WebSocket | null = null;
  private _connected = false;
  private _reconnectAttempts = 0;
  private _subscriptions = new Map<string, PendingSubscription[]>();
  private _fallbackListeners: TransportFallbackCallback[] = [];
  private _disconnectListeners: Array<(reason?: string) => void> = [];
  private _reconnectListeners: Array<(attempt: number, max: number) => void> = [];
  private _connectListeners: Array<() => void> = [];
  private _rpcUrl: string;
  private _wsUrl: string;
  private _stopped = false;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _wsFactory: (() => WebSocket) | null = null;

  constructor(rpcUrl: string, wsUrl?: string, wsFactory?: () => WebSocket) {
    this._rpcUrl = rpcUrl;
    this._wsUrl = wsUrl ?? rpcUrlToWsUrl(rpcUrl);
    this._wsFactory = wsFactory ?? null;
  }

  private _getWebSocket(): WebSocket {
    if (this._wsFactory) {
      return this._wsFactory();
    }
    if (typeof WebSocket !== 'undefined') {
      return new WebSocket(this._wsUrl);
    }
    throw new Error(
      'WebSocket is not available in this environment. ' +
      'In Node.js, install the "ws" package and pass a wsFactory to the WebSocketTransport constructor.'
    );
  }

  private _connect(): void {
    if (this._stopped) return;

    try {
      this._ws = this._getWebSocket();
    } catch {
      this._handleConnectionFailure();
      return;
    }

    this._ws.onopen = () => {
      this._connected = true;
      this._reconnectAttempts = 0;
      for (const cb of this._connectListeners) {
        try { cb(); } catch { }
      }
    };

    this._ws.onclose = (event) => {
      this._connected = false;
      this._ws = null;
      for (const cb of this._disconnectListeners) {
        try { cb(event.reason); } catch { }
      }
      this._scheduleReconnect();
    };

    this._ws.onerror = () => {
      this._connected = false;
    };

    this._ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data as string) as {
          type?: string;
          invoiceId?: string;
          data?: unknown;
        };
        if (!parsed.type || !parsed.invoiceId) return;

        const subs = this._subscriptions.get(parsed.invoiceId);
        if (!subs) return;

        for (const sub of subs) {
          try {
            sub.handler(parsed);
          } catch { }
        }
      } catch {
        // Malformed message — skip
      }
    };
  }

  private _scheduleReconnect(): void {
    if (this._stopped) return;

    this._reconnectAttempts++;

    if (this._reconnectAttempts > WS_MAX_RECONNECT_ATTEMPTS) {
      this._emitFallback();
      return;
    }

    const delay = Math.min(
      WS_RECONNECT_BASE_MS * Math.pow(2, this._reconnectAttempts - 1),
      WS_RECONNECT_MAX_MS
    );

    for (const cb of this._reconnectListeners) {
      try { cb(this._reconnectAttempts, WS_MAX_RECONNECT_ATTEMPTS); } catch { }
    }

    this._reconnectTimer = setTimeout(() => {
      this._connect();
    }, delay);
  }

  private _handleConnectionFailure(): void {
    this._reconnectAttempts++;
    if (this._reconnectAttempts > WS_MAX_RECONNECT_ATTEMPTS) {
      this._emitFallback();
      return;
    }
    this._scheduleReconnect();
  }

  private _emitFallback(): void {
    for (const cb of this._fallbackListeners) {
      try {
        cb({ from: 'websocket', to: 'http' });
      } catch { }
    }
  }

  onFallback(cb: TransportFallbackCallback): void {
    this._fallbackListeners.push(cb);
  }

  onDisconnect(cb: (reason?: string) => void): void {
    this._disconnectListeners.push(cb);
  }

  onReconnect(cb: (attempt: number, max: number) => void): void {
    this._reconnectListeners.push(cb);
  }

  onConnect(cb: () => void): void {
    this._connectListeners.push(cb);
  }

  subscribe(invoiceId: string, handler: (event: unknown) => void): void {
    const subs = this._subscriptions.get(invoiceId) ?? [];
    subs.push({ invoiceId, handler });
    this._subscriptions.set(invoiceId, subs);

    if (!this._connected && this._ws === null) {
      this._connect();
    }
  }

  unsubscribe(invoiceId: string, handler: (event: unknown) => void): void {
    const subs = this._subscriptions.get(invoiceId);
    if (!subs) return;

    const filtered = subs.filter((s) => s.handler !== handler);
    if (filtered.length === 0) {
      this._subscriptions.delete(invoiceId);
    } else {
      this._subscriptions.set(invoiceId, filtered);
    }

    if (this._subscriptions.size === 0) {
      this.disconnect();
    }
  }

  disconnect(): void {
    this._stopped = true;
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      this._ws.onclose = null;
      this._ws.onerror = null;
      this._ws.onmessage = null;
      this._ws.close();
      this._ws = null;
    }
    this._connected = false;
  }

  getStatus(): TransportStatus {
    return {
      type: 'websocket',
      connected: this._connected,
      reconnectAttempts: this._reconnectAttempts,
    };
  }

  get hasSubscriptions(): boolean {
    return this._subscriptions.size > 0;
  }
}
