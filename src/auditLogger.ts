import { truncateAddress } from "./utils.js";

export interface AuditEntry {
  timestamp: number;
  method: string;
  params: Record<string, unknown>;
  success: boolean;
  durationMs: number;
}

const STELLAR_ADDRESS_RE = /^G[A-Z0-9]{55}$/;

export class AuditLogger {
  private readonly sink: (entry: AuditEntry) => void;

  constructor(sink: (entry: AuditEntry) => void) {
    this.sink = sink;
  }

  log(entry: AuditEntry): void {
    this.sink(entry);
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
}
