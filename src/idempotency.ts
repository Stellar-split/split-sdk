import { createHash } from "crypto";

export interface IdempotencyConfig {
  /** Duration (ms) to remember completed keys. Default: 300_000 (5 min). */
  ttlMs?: number;
  /** Max entries in the key store before evicting oldest. Default: 10_000. */
  maxEntries?: number;
}

interface IdempotencyEntry {
  result: { txHash: string; returnValue?: string };
  expiresAt: number;
}

export class IdempotencyManager {
  private readonly store = new Map<string, IdempotencyEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(config?: IdempotencyConfig) {
    this.ttlMs = config?.ttlMs ?? 300_000;
    this.maxEntries = config?.maxEntries ?? 10_000;
  }

  generateKey(
    sourceAddress: string,
    operationXdr: string
  ): string {
    const raw = `${sourceAddress}:${operationXdr}`;
    return createHash("sha256").update(raw).digest("hex");
  }

  tryClaim(
    key: string,
    result: { txHash: string; returnValue?: string }
  ): { duplicate: boolean; existing?: { txHash: string } } {
    this.sweep();

    const existing = this.store.get(key);
    if (existing) {
      return {
        duplicate: true,
        existing: { txHash: existing.result.txHash },
      };
    }

    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next();
      if (oldest.value) this.store.delete(oldest.value);
    }

    this.store.set(key, {
      result,
      expiresAt: Date.now() + this.ttlMs,
    });

    return { duplicate: false };
  }

  isDuplicate(key: string): boolean {
    this.sweep();
    return this.store.has(key);
  }

  getResult(key: string): { txHash: string } | null {
    this.sweep();
    const entry = this.store.get(key);
    return entry ? { txHash: entry.result.txHash } : null;
  }

  clear(): void {
    this.store.clear();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }
}
