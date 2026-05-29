/**
 * Invoice expiry watcher for StellarSplit.
 */

import type { StellarSplitClient } from "./client.js";

/** Event fired when an invoice is expiring or has expired. */
export interface ExpiryEvent {
  /** Invoice ID. */
  invoiceId: string;
  /** Unix timestamp deadline (seconds). */
  deadline: number;
  /** Seconds remaining until deadline. */
  secondsRemaining: number;
  /** True if deadline has passed. */
  expired: boolean;
}

/** Callback function for expiry events. */
export type ExpiryCallback = (event: ExpiryEvent) => void;

/**
 * Watch an invoice for expiry and fire a callback when approaching deadline.
 *
 * Polls the invoice deadline and fires the callback when the deadline is within
 * the warning window or has passed.
 *
 * @param invoiceId - Invoice ID to watch
 * @param client - StellarSplitClient instance
 * @param callback - Function to call when expiry event occurs
 * @param warningSeconds - Seconds before deadline to trigger callback (default: 3600)
 * @returns Cleanup function to stop polling
 */
export function watchExpiry(
  invoiceId: string,
  client: StellarSplitClient,
  callback: ExpiryCallback,
  warningSeconds: number = 3600
): () => void {
  let hasTriggered = false;

  const intervalId = setInterval(async () => {
    try {
      const invoice = await client.getInvoice(invoiceId);
      const now = Math.floor(Date.now() / 1000);
      const secondsRemaining = invoice.deadline - now;
      const expired = secondsRemaining <= 0;

      if (secondsRemaining <= warningSeconds && !hasTriggered) {
        hasTriggered = true;
        callback({
          invoiceId,
          deadline: invoice.deadline,
          secondsRemaining,
          expired,
        });
      } else if (expired && !hasTriggered) {
        hasTriggered = true;
        callback({
          invoiceId,
          deadline: invoice.deadline,
          secondsRemaining,
          expired: true,
        });
      }
    } catch (error) {
      console.error(`Error watching invoice ${invoiceId}:`, error);
    }
  }, 1000);

  return () => clearInterval(intervalId);
}
