import { truncateAddress } from "./utils.js";
import { decodeXDR } from "./xdrDecoder.js";
import type { XDRType, DecodedXDR, SplitAuditEntry } from "./types.js";

export interface AuditEntry {
  timestamp: number;
  method: string;
  params: Record<string, unknown>;
  success: boolean;
  durationMs: number;
  /** Optional decoded XDR payload attached to this audit entry. */
  decodedXdr?: DecodedXDR;
}

/**
 * A single audit event emitted by the SDK for compliance tracking.
 *
 * Unlike {@link AuditEntry}, which is a low-level sink record, an
 * `AuditEvent` carries a stable `type` discriminator and a monotonically
 * increasing `sequence` so downstream consumers can order and reconcile
 * events reliably.
 */
export interface AuditEvent {
  /** Stable event type discriminator, e.g. `"audit.log"`. */
  type: string;
  /** Monotonically increasing sequence number, starting at 1. */
  sequence: number;
  /** Wall-clock time the event was emitted (ms since epoch). */
  timestamp: number;
  /** The audit entry associated with this event. */
  entry: AuditEntry;
}

/** Handler invoked for every emitted {@link AuditEvent}. */
export type AuditEventListener = (event: AuditEvent) => void;

/**
 * A single invoice notification subscription.
 *
 * Represents a consumer's interest in receiving notifications for a given
 * invoice. Subscriptions are keyed by `invoiceId` and may be filtered by the
 * notification `events` the subscriber cares about.
 */
export interface InvoiceNotificationSubscription {
  /** Unique identifier for the subscription. */
  id: string;
  /** The invoice this subscription is bound to. */
  invoiceId: string;
  /** Callback invoked when a matching invoice notification is emitted. */
  handler: (notification: InvoiceNotification) => void;
  /** Optional subset of events to receive; when omitted, all events fire. */
  events?: InvoiceNotificationEvent[];
}

/** Notification event types emitted for invoice lifecycle changes. */
export type InvoiceNotificationEvent =
  | "invoice_created"
  | "invoice_paid"
  | "invoice_settled"
  | "invoice_expired"
  | "invoice_cancelled";

/** A notification payload delivered to matching invoice subscribers. */
export interface InvoiceNotification {
  /** The invoice the notification pertains to. */
  invoiceId: string;
  /** The lifecycle event that triggered the notification. */
  event: InvoiceNotificationEvent;
  /** Epoch ms at which the notification was emitted. */
  timestamp: number;
  /** Optional additional context for the notification. */
  data?: Record<string, unknown>;
}

/**
 * A single cross-tenant invoice audit record.
 *
 * Captures which tenant performed an action against an invoice owned by
 * another tenant, so cross-tenant access can be recorded, queried, and
 * verified after the fact.
 */
export interface CrossTenantInvoiceAuditEntry {
  /** Tenant that owns the invoice being acted upon. */
  ownerTenantId: string;
  /** Tenant that performed the action. */
  actorTenantId: string;
  /** Invoice the action targeted. */
  invoiceId: string;
  /** Action performed (e.g. "read", "settle", "refund"). */
  action: string;
  /** Whether the cross-tenant access was authorized. */
  authorized: boolean;
  /** When the action occurred (epoch ms). */
  timestamp: number;
  /** Optional free-form context for the action. */
  metadata?: Record<string, unknown>;
}

/** Lifecycle events emitted by the cross-tenant invoice auditor. */
export type CrossTenantAuditEvent =
  | { type: "invoice_audited"; entry: CrossTenantInvoiceAuditEntry }
  | { type: "cross_tenant_access_detected"; entry: CrossTenantInvoiceAuditEntry }
  | { type: "cross_tenant_access_denied"; entry: CrossTenantInvoiceAuditEntry };

export type CrossTenantAuditEventListener = (
  event: CrossTenantAuditEvent,
) => void;

/** Lifecycle events emitted when SDK debug mode is toggled. */
export type DebugModeEvent =
  | { type: "debug_mode_enabled" }
  | { type: "debug_mode_disabled" };

export type DebugModeEventListener = (event: DebugModeEvent) => void;

/** Actions recorded against a stored key for compliance tracking. */
export type KeyUsageAction =
  | "key_access"
  | "key_rotation"
  | "key_access_denied";

/**
 * A single key-usage audit record.
 *
 * Captures who accessed (or attempted to access) a stored key, which key was
 * targeted, and the outcome. Key material itself is never recorded.
 */
export interface KeyUsageAuditEntry {
  /** Identifier of the key that was acted upon. */
  keyId: string;
  /** The action performed against the key. */
  action: KeyUsageAction;
  /** Principal (user, service, tenant) that performed the action. */
  actor: string;
  /** Whether the action was permitted. */
  authorized: boolean;
  /** When the action occurred (epoch ms). */
  timestamp: number;
  /** Optional free-form context (e.g. reason for denial, rotation version). */
  metadata?: Record<string, unknown>;
}

/** Lifecycle events emitted for key-usage auditing. */
export type KeyUsageAuditEvent =
  | { type: "key_accessed"; entry: KeyUsageAuditEntry }
  | { type: "key_rotated"; entry: KeyUsageAuditEntry }
  | { type: "key_access_denied"; entry: KeyUsageAuditEntry };

export type KeyUsageAuditEventListener = (event: KeyUsageAuditEvent) => void;

const STELLAR_ADDRESS_RE = /^G[A-Z0-9]{55}$/;

/** Detect if a string value looks like base64-encoded XDR. */
const XDR_BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Heuristic minimum length for XDR base64 strings (at least ~40 chars for a minimal tx). */
const MIN_XDR_LENGTH = 40;

export class AuditLogger {
  private readonly sink: (entry: AuditEntry) => void;
  private readonly splitAuditTrails = new Map<string, SplitAuditEntry[]>();
  private readonly listeners = new Set<AuditEventListener>();
  private readonly invoiceSubscriptions = new Map<
    string,
    InvoiceNotificationSubscription[]
  >();
  private readonly crossTenantAudits: CrossTenantInvoiceAuditEntry[] = [];
  private readonly crossTenantListeners = new Set<CrossTenantAuditEventListener>();
  private readonly keyUsageAudits: KeyUsageAuditEntry[] = [];
  private readonly keyUsageListeners = new Set<KeyUsageAuditEventListener>();
  private readonly debugListeners = new Set<DebugModeEventListener>();
  private debugEnabled = false;
  private sequence = 0;

  constructor(sink: (entry: AuditEntry) => void) {
    this.sink = sink;
  }

  /**
   * Enable or disable SDK debug mode.
   *
   * When enabled, verbose diagnostic output is written for every audit
   * operation. Toggling emits a `debug_mode_enabled` / `debug_mode_disabled`
   * event to all subscribers registered via {@link onDebugModeChange}.
   */
  setDebugMode(enabled: boolean): void {
    if (this.debugEnabled === enabled) {
      return;
    }
    this.debugEnabled = enabled;
    this.emitDebugMode({
      type: enabled ? "debug_mode_enabled" : "debug_mode_disabled",
    });
  }

  /** Whether SDK debug mode is currently enabled. */
  isDebugModeEnabled(): boolean {
    return this.debugEnabled;
  }

  /**
   * Subscribe to debug mode state changes.
   *
   * @returns an unsubscribe function.
   */
  onDebugModeChange(listener: DebugModeEventListener): () => void {
    this.debugListeners.add(listener);
    return () => {
      this.debugListeners.delete(listener);
    };
  }

  /** Emit a verbose debug log line when debug mode is enabled. */
  private debugLog(message: string, context?: Record<string, unknown>): void {
    if (!this.debugEnabled) {
      return;
    }
    const suffix = context ? ` ${JSON.stringify(context)}` : "";
    // eslint-disable-next-line no-console
    console.debug(`[AuditLogger] ${message}${suffix}`);
  }

  private emitDebugMode(event: DebugModeEvent): void {
    for (const listener of this.debugListeners) {
      listener(event);
    }
  }

  /**
   * Subscribe to audit events. Returns an unsubscribe function.
   *
   * Listeners are invoked synchronously after the entry has been written to
   * the configured sink, so a throwing listener can never prevent the audit
   * record from being persisted.
   */
  on(listener: AuditEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Remove a previously registered listener. */
  off(listener: AuditEventListener): void {
    this.listeners.delete(listener);
  }

  /** Emit an audit event to all registered listeners. */
  private emit(entry: AuditEntry): void {
    if (this.listeners.size === 0) {
      return;
    }
    const event: AuditEvent = {
      type: "audit.log",
      sequence: ++this.sequence,
      timestamp: entry.timestamp,
      entry,
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A misbehaving listener must never break audit logging.
      }
    }
  }

  log(entry: AuditEntry): void {
    this.debugLog("log", {
      method: entry.method,
      success: entry.success,
      durationMs: entry.durationMs,
    });
    this.sink(entry);
    this.emit(entry);
  }

  sanitize(params: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(params).map(([k, v]) => [
        k,
        typeof v === "string" && STELLAR_ADDRESS_RE.test(v)
          ? truncateAddress(v)
          : v,
      ])
    );
  }

  /**
   * Register a subscription for invoice notifications.
   *
   * @param subscription - The subscription to register.
   * @returns An unsubscribe function that removes the subscription.
   */
  subscribeToInvoice(
    subscription: InvoiceNotificationSubscription,
  ): () => void {
    const existing = this.invoiceSubscriptions.get(subscription.invoiceId) ?? [];
    existing.push(subscription);
    this.invoiceSubscriptions.set(subscription.invoiceId, existing);

    return () => this.unsubscribeFromInvoice(subscription.id);
  }

  /**
   * Remove a previously registered invoice notification subscription by id.
   *
   * @returns `true` when a subscription was removed, `false` otherwise.
   */
  unsubscribeFromInvoice(subscriptionId: string): boolean {
    for (const [invoiceId, subs] of this.invoiceSubscriptions) {
      const index = subs.findIndex((s) => s.id === subscriptionId);
      if (index !== -1) {
        subs.splice(index, 1);
        if (subs.length === 0) {
          this.invoiceSubscriptions.delete(invoiceId);
        }
        return true;
      }
    }
    return false;
  }

  /**
   * Emit an invoice notification to all matching subscribers.
   *
   * Subscribers registered for the invoice receive the notification when they
   * have no event filter or when their filter includes the emitted event.
   * Handler errors are isolated so one failing subscriber cannot prevent
   * delivery to the others.
   *
   * @param notification - The notification to deliver.
   * @returns The number of subscribers the notification was delivered to.
   */
  emitInvoiceNotification(notification: InvoiceNotification): number {
    const subs = this.invoiceSubscriptions.get(notification.invoiceId);
    if (!subs || subs.length === 0) return 0;

    let delivered = 0;
    for (const sub of subs) {
      if (sub.events && !sub.events.includes(notification.event)) continue;
      try {
        sub.handler(notification);
        delivered += 1;
      } catch {
        // Isolate subscriber failures; never break notification delivery.
      }
    }
    return delivered;
  }

  /**
   * Log an entry with automatic XDR decoding.
   *
   * When `xdrPayload` is provided, it is decoded and attached as `decodedXdr`.
   * This produces structured JSON safe for log aggregation, audit trails,
   * and developer UIs — no external XDR converters needed.
   *
   * @param entry     - Base audit entry.
   * @param xdrPayload - Base64-encoded XDR to decode (e.g. a transaction envelope).
   * @param xdrType    - The expected XDR type.
   */
  logWithXdr(
    entry: AuditEntry,
    xdrPayload: string,
    xdrType: XDRType,
  ): void {
    try {
      if (
        xdrPayload.length >= MIN_XDR_LENGTH &&
        XDR_BASE64_RE.test(xdrPayload)
      ) {
        entry.decodedXdr = decodeXDR(xdrPayload, xdrType);
      }
    } catch {
      // Decoding best-effort; never fail an audit log write.
    }
    this.log(entry);
  }

  /**
   * Auto-detect and decode XDR payloads embedded in audit params.
   *
   * Scans `entry.params` for keys matching known XDR field names
   * ("xdr", "txXdr", "envelopeXdr", "resultXdr", "metaXdr")
   * and attempts to decode them, attaching the result to `entry.decodedXdr`.
   */
  logAndDecodeXdr(entry: AuditEntry): void {
    const xdrKeys: Array<{ key: string; type: XDRType }> = [
      { key: "xdr", type: "TransactionEnvelope" },
      { key: "txXdr", type: "TransactionEnvelope" },
      { key: "envelopeXdr", type: "TransactionEnvelope" },
      { key: "resultXdr", type: "TransactionResult" },
      { key: "metaXdr", type: "TransactionMeta" },
    ];

    for (const { key, type } of xdrKeys) {
      const value = entry.params[key];
      if (typeof value === "string" && value.length >= MIN_XDR_LENGTH) {
        try {
          entry.decodedXdr = decodeXDR(value, type);
          break; // Decode the first match only
        } catch {
          // continue to next key
        }
      }
    }

    this.log(entry);
  }

  /**
   * Record a `SplitAuditEntry` for a single settled leg of a multi-recipient
   * split payment. Writes immediately to the configured sink (as an
   * `AuditEntry`) and to the in-memory per-invoice trail returned by
   * {@link exportSplitAuditTrail}.
   */
  recordSplitLeg(entry: SplitAuditEntry): void {
    const trail = this.splitAuditTrails.get(entry.invoiceId) ?? [];
    trail.push(entry);
    this.splitAuditTrails.set(entry.invoiceId, trail);

    this.log({
      timestamp: entry.settledAt,
      method: "split_leg_settled",
      params: this.sanitize({
        invoiceId: entry.invoiceId,
        legIndex: entry.legIndex,
        recipientId: entry.recipientId,
        assetCode: entry.assetCode,
        amount: entry.amount.toString(),
        operationId: entry.operationId,
        ledgerSequence: entry.ledgerSequence,
      }),
      success: true,
      durationMs: 0,
    });
  }

  /**
   * Return all recorded `SplitAuditEntry` records for `invoiceId`, in the
   * order they were settled.
   */
  async exportSplitAuditTrail(invoiceId: string): Promise<SplitAuditEntry[]> {
    return [...(this.splitAuditTrails.get(invoiceId) ?? [])];
  }

  /**
   * Subscribe to cross-tenant invoice audit lifecycle events.
   *
   * @returns an unsubscribe function.
   */
  onCrossTenantAudit(listener: CrossTenantAuditEventListener): () => void {
    this.crossTenantListeners.add(listener);
    return () => {
      this.crossTenantListeners.delete(listener);
    };
  }

  /**
   * Record a cross-tenant invoice audit entry.
   *
   * Persists the entry to the in-memory cross-tenant trail, writes a
   * sanitized `AuditEntry` to the configured sink, and emits the appropriate
   * lifecycle event:
   * - `cross_tenant_access_detected` when the actor differs from the owner,
   * - `cross_tenant_access_denied` when such access is unauthorized,
   * - `invoice_audited` for every recorded entry.
   */
  recordCrossTenantInvoiceAudit(
    entry: CrossTenantInvoiceAuditEntry,
  ): void {
    this.crossTenantAudits.push(entry);

    this.log({
      timestamp: entry.timestamp,
      method: "cross_tenant_invoice_audit",
      params: this.sanitize({
        ownerTenantId: entry.ownerTenantId,
        actorTenantId: entry.actorTenantId,
        invoiceId: entry.invoiceId,
        action: entry.action,
        authorized: entry.authorized,
        ...(entry.metadata ?? {}),
      }),
      success: entry.authorized,
      durationMs: 0,
    });

    const isCrossTenant = entry.actorTenantId !== entry.ownerTenantId;
    if (isCrossTenant) {
      this.emitCrossTenantAudit({
        type: "cross_tenant_access_detected",
        entry,
      });
      if (!entry.authorized) {
        this.emitCrossTenantAudit({
          type: "cross_tenant_access_denied",
          entry,
        });
      }
    }
    this.emitCrossTenantAudit({ type: "invoice_audited", entry });
  }

  /**
   * Query recorded cross-tenant invoice audit entries.
   *
   * All filters are optional and combined with AND semantics. Results are
   * returned in the order they were recorded.
   */
  queryCrossTenantInvoiceAudits(filter?: {
    ownerTenantId?: string;
    actorTenantId?: string;
    invoiceId?: string;
    action?: string;
    authorized?: boolean;
  }): CrossTenantInvoiceAuditEntry[] {
    return this.crossTenantAudits.filter((entry) => {
      if (filter?.ownerTenantId && entry.ownerTenantId !== filter.ownerTenantId) {
        return false;
      }
      if (filter?.actorTenantId && entry.actorTenantId !== filter.actorTenantId) {
        return false;
      }
      if (filter?.invoiceId && entry.invoiceId !== filter.invoiceId) {
        return false;
      }
      if (filter?.action && entry.action !== filter.action) {
        return false;
      }
      if (
        filter?.authorized !== undefined &&
        entry.authorized !== filter.authorized
      ) {
        return false;
      }
      return true;
    });
  }

  private emitCrossTenantAudit(event: CrossTenantAuditEvent): void {
    for (const listener of this.crossTenantListeners) {
      listener(event);
    }
  }

  /**
   * Subscribe to key-usage audit lifecycle events.
   *
   * @returns an unsubscribe function.
   */
  onKeyUsageAudit(listener: KeyUsageAuditEventListener): () => void {
    this.keyUsageListeners.add(listener);
    return () => {
      this.keyUsageListeners.delete(listener);
    };
  }

  /**
   * Record a key-usage audit entry.
   *
   * Persists the entry to the in-memory key-usage trail, writes a sanitized
   * `AuditEntry` to the configured sink, and emits the matching lifecycle
   * event. Key material is never included in the recorded metadata.
   */
  recordKeyUsageAudit(entry: KeyUsageAuditEntry): void {
    this.keyUsageAudits.push(entry);

    this.log({
      timestamp: entry.timestamp,
      method: entry.action,
      params: this.sanitize({
        keyId: entry.keyId,
        actor: entry.actor,
        authorized: entry.authorized,
        ...(entry.metadata ?? {}),
      }),
      success: entry.authorized,
      durationMs: 0,
    });

    const eventType =
      entry.action === "key_rotation"
        ? "key_rotated"
        : entry.action === "key_access_denied"
          ? "key_access_denied"
          : "key_accessed";

    this.emitKeyUsageAudit({ type: eventType, entry });
  }

  /**
   * Query recorded key-usage audit entries.
   *
   * All filters are optional and combined with AND semantics. Results are
   * returned in the order they were recorded.
   */
  queryKeyUsageAudits(filter?: {
    keyId?: string;
    action?: KeyUsageAction;
    actor?: string;
    authorized?: boolean;
  }): KeyUsageAuditEntry[] {
    return this.keyUsageAudits.filter((entry) => {
      if (filter?.keyId && entry.keyId !== filter.keyId) {
        return false;
      }
      if (filter?.action && entry.action !== filter.action) {
        return false;
      }
      if (filter?.actor && entry.actor !== filter.actor) {
        return false;
      }
      if (
        filter?.authorized !== undefined &&
        entry.authorized !== filter.authorized
      ) {
        return false;
      }
      return true;
    });
  }

  private emitKeyUsageAudit(event: KeyUsageAuditEvent): void {
    for (const listener of this.keyUsageListeners) {
      try {
        listener(event);
      } catch {
        // A misbehaving listener must never break key-usage auditing.
      }
    }
  }
}
