/**
 * Session-bound CSRF token issuance for {@link SplitClient}'s web
 * integration surface. Distinct from {@link CsrfProtection} (stateless,
 * request-header-driven, for HTTP middleware): this one binds tokens to an
 * explicit session id supplied by the caller.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface CsrfConfig {
  /** HMAC signing secret. A random one is generated when omitted. */
  secret?: string;
  /** Token lifetime in milliseconds. Defaults to 30 minutes. */
  ttlMs?: number;
}

export interface CsrfEvent {
  sessionId: string;
  action: "issued" | "validated" | "rejected" | "refreshed";
  timestamp: number;
}

export class CsrfProtector {
  private readonly secret: string;
  private readonly ttlMs: number;
  private readonly events: CsrfEvent[] = [];
  private readonly maxEvents = 1000;

  constructor(config?: CsrfConfig) {
    this.secret = config?.secret ?? randomBytes(32).toString("hex");
    this.ttlMs = config?.ttlMs ?? 30 * 60 * 1000;
  }

  issueToken(sessionId: string): string {
    const issuedAt = Date.now();
    const nonce = randomBytes(16).toString("hex");
    const payload = `${sessionId}.${issuedAt}.${nonce}`;
    const signature = createHmac("sha256", this.secret).update(payload).digest("hex");
    this._record(sessionId, "issued");
    return `${issuedAt}.${nonce}.${signature}`;
  }

  validateToken(sessionId: string, token: string): boolean {
    const parts = token.split(".");
    if (parts.length !== 3) {
      this._record(sessionId, "rejected");
      return false;
    }
    const [issuedAtRaw, nonce, signature] = parts;
    const payload = `${sessionId}.${issuedAtRaw}.${nonce}`;
    const expected = createHmac("sha256", this.secret).update(payload).digest("hex");

    const sigBuf = Buffer.from(signature!, "hex");
    const expectedBuf = Buffer.from(expected, "hex");
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
      this._record(sessionId, "rejected");
      return false;
    }

    const issuedAt = Number(issuedAtRaw);
    if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > this.ttlMs) {
      this._record(sessionId, "rejected");
      return false;
    }

    this._record(sessionId, "validated");
    return true;
  }

  refreshToken(sessionId: string): string {
    this._record(sessionId, "refreshed");
    return this.issueToken(sessionId);
  }

  getEvents(): ReadonlyArray<CsrfEvent> {
    return [...this.events];
  }

  private _record(sessionId: string, action: CsrfEvent["action"]): void {
    this.events.push({ sessionId, action, timestamp: Date.now() });
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }
}
