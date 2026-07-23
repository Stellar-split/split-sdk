/**
 * useInvoiceStream Hook
 * 
 * Custom React hook for real-time invoice updates via Server-Sent Events (SSE)
 * or polling mechanism.
 * 
 * @module ui/hooks/useInvoiceStream
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { Invoice, DisputeStatus } from '../../types.js';
import type { StellarSplitClient } from '../../client.js';

export interface UseInvoiceStreamOptions {
  /** Invoice ID to stream */
  invoiceId: string;
  /** StellarSplit SDK client instance */
  client: StellarSplitClient;
  /** Enable real-time streaming (vs. polling) */
  enabled?: boolean;
  /** Polling interval in milliseconds (if not using SSE) */
  pollingInterval?: number;
  /** Callback when invoice updates */
  onUpdate?: (invoice: Invoice) => void;
  /** Callback when dispute status changes */
  onDisputeUpdate?: (disputeStatus: DisputeStatus) => void;
  /** Callback on error */
  onError?: (error: Error) => void;
}

export interface UseInvoiceStreamResult {
  /** Current invoice data */
  invoice: Invoice | null;
  /** Current dispute status */
  disputeStatus: DisputeStatus | null;
  /** Loading state */
  loading: boolean;
  /** Error state */
  error: Error | null;
  /** Whether streaming is active */
  isConnected: boolean;
  /** Manually refresh invoice data */
  refresh: () => Promise<void>;
  /** Reconnect stream if disconnected */
  reconnect: () => void;
}

/**
 * useInvoiceStream - Real-time invoice updates
 * 
 * Features:
 * - Real-time updates via SSE or polling
 * - Automatic reconnection on disconnect
 * - Manual refresh capability
 * - Separate dispute status tracking
 * - Error handling and recovery
 * 
 * @example
 * ```tsx
 * const { invoice, disputeStatus, loading, error } = useInvoiceStream({
 *   invoiceId: '123',
 *   client: sdkClient,
 *   enabled: true,
 *   onDisputeUpdate: (status) => console.log('Dispute updated:', status)
 * });
 * ```
 */
export function useInvoiceStream(
  options: UseInvoiceStreamOptions
): UseInvoiceStreamResult {
  const {
    invoiceId,
    client,
    enabled = true,
    pollingInterval = 5000,
    onUpdate,
    onDisputeUpdate,
    onError,
  } = options;

  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [disputeStatus, setDisputeStatus] = useState<DisputeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const mountedRef = useRef(true);

  // Fetch invoice data
  const fetchInvoice = useCallback(async () => {
    if (!invoiceId || !client) return;

    try {
      const invoiceData = await client.getInvoice(invoiceId);
      
      if (!mountedRef.current) return;

      setInvoice(invoiceData);
      setError(null);

      // Call update callback
      if (onUpdate) {
        onUpdate(invoiceData);
      }

      // Fetch dispute status if invoice is in disputed state
      // Check if there's a separate dispute status method available
      try {
        const dispute = await client.getDisputeStatus(invoiceId);
        
        if (!mountedRef.current) return;

        // Only set if dispute is active
        if (dispute.disputed) {
          setDisputeStatus(dispute);

          // Call dispute update callback
          if (onDisputeUpdate) {
            onDisputeUpdate(dispute);
          }
        }
      } catch (disputeError) {
        // If dispute status fetch fails, it might not be disputed
        // This is acceptable - just log and continue
        console.debug('No active dispute or failed to fetch dispute status:', disputeError);
      }
    } catch (err) {
      if (!mountedRef.current) return;

      const error = err instanceof Error ? err : new Error(String(err));
      setError(error);

      if (onError) {
        onError(error);
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [invoiceId, client, onUpdate, onDisputeUpdate, onError]);

  // Manual refresh
  const refresh = useCallback(async () => {
    setLoading(true);
    await fetchInvoice();
  }, [fetchInvoice]);

  // Setup SSE connection (if supported and available)
  const setupSSE = useCallback(() => {
    // Check if SSE endpoint exists in client
    if (typeof client.getSSEEndpoint !== 'function') {
      // Fall back to polling if SSE not available
      return false;
    }

    try {
      const sseUrl = client.getSSEEndpoint(`/invoice/${invoiceId}`);
      const eventSource = new EventSource(sseUrl);

      eventSource.onopen = () => {
        setIsConnected(true);
      };

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          if (data.type === 'invoice_update') {
            setInvoice(data.invoice);
            if (onUpdate) onUpdate(data.invoice);
          }

          if (data.type === 'dispute_update') {
            setDisputeStatus(data.disputeStatus);
            if (onDisputeUpdate) onDisputeUpdate(data.disputeStatus);
          }
        } catch (parseError) {
          console.error('Failed to parse SSE message:', parseError);
        }
      };

      eventSource.onerror = () => {
        setIsConnected(false);
        eventSource.close();
        
        // Reconnect after delay
        setTimeout(() => {
          if (mountedRef.current && enabled) {
            setupSSE();
          }
        }, 3000);
      };

      eventSourceRef.current = eventSource;
      return true;
    } catch (err) {
      console.error('Failed to setup SSE:', err);
      return false;
    }
  }, [client, invoiceId, enabled, onUpdate, onDisputeUpdate]);

  // Setup polling fallback
  const setupPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }

    // Initial fetch
    fetchInvoice();

    // Setup polling
    intervalRef.current = setInterval(() => {
      fetchInvoice();
    }, pollingInterval);

    setIsConnected(true);
  }, [fetchInvoice, pollingInterval]);

  // Reconnect stream
  const reconnect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    if (enabled) {
      const sseConnected = setupSSE();
      if (!sseConnected) {
        setupPolling();
      }
    }
  }, [enabled, setupSSE, setupPolling]);

  // Setup stream on mount
  useEffect(() => {
    if (!enabled || !invoiceId || !client) {
      setLoading(false);
      return;
    }

    // Try SSE first, fall back to polling
    const sseConnected = setupSSE();
    if (!sseConnected) {
      setupPolling();
    }

    // Cleanup on unmount
    return () => {
      mountedRef.current = false;

      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }

      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }

      setIsConnected(false);
    };
  }, [enabled, invoiceId, client, setupSSE, setupPolling]);

  return {
    invoice,
    disputeStatus,
    loading,
    error,
    isConnected,
    refresh,
    reconnect,
  };
}

export default useInvoiceStream;
