/**
 * Standalone pure helpers used by the client (no client state).
 * Re-exported from `../client.ts` so the public API is unchanged.
 */
import type { Invoice, ScheduledReleaseCountdown, CompletionProof } from "../types.js";

/** Shared countdown computation used by client method and standalone function. */
export function _computeCountdown(target: number): ScheduledReleaseCountdown {
  const now = Math.floor(Date.now() / 1000);
  const diff = target - now;
  if (diff <= 0) {
    return {
      total_seconds: 0,
      days: 0,
      hours: 0,
      minutes: 0,
      seconds: 0,
      overdue: true,
    };
  }
  return {
    total_seconds: diff,
    days: Math.floor(diff / 86400),
    hours: Math.floor((diff % 86400) / 3600),
    minutes: Math.floor((diff % 3600) / 60),
    seconds: diff % 60,
    overdue: false,
  };
}

/**
 * Standalone pure function — computes time remaining until a scheduled release.
 * Returns null when the invoice has no scheduled_release_at field.
 *
 * @param invoice - Invoice object from the contract.
 * @returns ScheduledReleaseCountdown or null.
 */
export function getScheduledReleaseCountdown(
  invoice: Invoice,
): ScheduledReleaseCountdown | null {
  const ts =
    (invoice as { scheduled_release_at?: number }).scheduled_release_at ??
    invoice.scheduledReleaseDate;
  if (ts === undefined) return null;
  return _computeCountdown(ts);
}

/**
 * Standalone pure function — verifies a CompletionProof from the contract.
 * Recomputes cert_hash from proof fields and compares against stored value.
 *
 * @param proof - CompletionProof from the contract's get_completion_proof call.
 * @returns { valid: boolean, reason?: string }
 */
export function verifyCompletionProof(proof: CompletionProof): {
  valid: boolean;
  reason?: string;
} {
  if (
    !proof.invoiceId ||
    !proof.releasedBy ||
    !proof.releasedAt ||
    !proof.cert_hash
  ) {
    return { valid: false, reason: "Missing required proof fields" };
  }
  const data = `${proof.invoiceId}${proof.releasedBy}${proof.releasedAt}${proof.totalAmount.toString()}`;
  const encoder = new TextEncoder();
  const buffer = encoder.encode(data);
  let hash = 0;
  for (let i = 0; i < buffer.length; i++) {
    hash = (hash << 5) - hash + (buffer[i] ?? 0);
    hash = hash & hash;
  }
  const computed = Math.abs(hash).toString(16).padStart(64, "0").slice(0, 64);
  if (computed !== proof.cert_hash) {
    return { valid: false, reason: "cert_hash mismatch" };
  }
  return { valid: true };
}

/** Coerce a native-decoded scalar (bigint | number | string) into a bigint, defaulting to 0n. */
export function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string" && value !== "") return BigInt(value);
  return 0n;
}
