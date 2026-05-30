import { Invoice } from "./types.js";

/**
 * Handler function for invoice state updates.
 */
type InvoiceHandler = (invoiceId: string, invoice: Invoice) => void;

/**
 * Invoice state broadcaster that publishes state changes to multiple subscribers.
 */
export class InvoiceStateBroadcaster {
  private subscribers: Map<string, Set<InvoiceHandler>> = new Map();

  /**
   * Subscribe to invoice state updates for a specific invoice ID.
   * 
   * @param invoiceId - The invoice ID to subscribe to
   * @param handler - The handler function to call when updates are received
   * @returns Unsubscribe function that removes only this subscriber
   */
  subscribe(invoiceId: string, handler: InvoiceHandler): () => void {
    if (!this.subscribers.has(invoiceId)) {
      this.subscribers.set(invoiceId, new Set());
    }
    
    const handlers = this.subscribers.get(invoiceId)!;
    handlers.add(handler);
    
    return () => {
      handlers.delete(handler);
      // Clean up empty sets
      if (handlers.size === 0) {
        this.subscribers.delete(invoiceId);
      }
    };
  }

  /**
   * Broadcast an invoice state update to all subscribers of the given invoice ID.
   * 
   * @param invoiceId - The invoice ID to broadcast to
   * @param invoice - The updated invoice state
   */
  broadcast(invoiceId: string, invoice: Invoice): void {
    const handlers = this.subscribers.get(invoiceId);
    if (!handlers || handlers.size === 0) {
      return; // No subscribers for this invoice ID
    }
    
    // Call all handlers with the updated invoice
    handlers.forEach((handler) => {
      try {
        handler(invoiceId, invoice);
      } catch (error) {
        console.error(`Error in invoice handler for ${invoiceId}:`, error);
      }
    });
  }

  /**
   * Get the number of subscribers for a given invoice ID.
   * 
   * @param invoiceId - The invoice ID to check
   * @returns Number of subscribers
   */
  getSubscriberCount(invoiceId: string): number {
    return this.subscribers.get(invoiceId)?.size ?? 0;
  }
}

/**
 * Creates a new InvoiceStateBroadcaster instance.
 * 
 * @returns A new InvoiceStateBroadcaster instance
 */
export function createInvoiceStateBroadcaster(): InvoiceStateBroadcaster {
  return new InvoiceStateBroadcaster();
}
