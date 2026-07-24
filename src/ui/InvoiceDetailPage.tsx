/**
 * InvoiceDetailPage Component
 * 
 * Complete invoice detail page with dispute management
 * 
 * @module ui/InvoiceDetailPage
 */

import React, { useCallback, useState, useMemo } from 'react';
import { DisputePanel } from './DisputePanel.js';
import { DisputeTimeline, type DisputeTimelineEvent } from './DisputeTimeline.js';
import { useInvoiceStream } from './hooks/useInvoiceStream.js';
import type { StellarSplitClient } from '../client.js';
import type { Invoice } from '../types.js';

export interface InvoiceDetailPageProps {
  /** Invoice ID */
  invoiceId: string;
  /** StellarSplit SDK client */
  client: StellarSplitClient;
  /** Current user's wallet address */
  userAddress?: string;
  /** Callback to upload file to IPFS */
  uploadToIPFS: (file: File) => Promise<string>;
  /** Optional custom class name */
  className?: string;
}

/**
 * InvoiceDetailPage - Complete invoice detail view
 * 
 * Features:
 * - Real-time invoice updates via useInvoiceStream
 * - Dispute panel (conditional on Disputed status)
 * - Evidence submission to IPFS
 * - Arbitrator voting
 * - Chronological event timeline
 * - Invoice information display
 */
export const InvoiceDetailPage: React.FC<InvoiceDetailPageProps> = ({
  invoiceId,
  client,
  userAddress,
  uploadToIPFS,
  className = '',
}) => {
  const [timelineEvents, setTimelineEvents] = useState<DisputeTimelineEvent[]>([]);

  // Real-time invoice updates
  const {
    invoice,
    disputeStatus,
    loading,
    error,
    isConnected,
    refresh,
  } = useInvoiceStream({
    invoiceId,
    client,
    enabled: true,
    onUpdate: (updatedInvoice) => {
      console.log('Invoice updated:', updatedInvoice);
    },
    onDisputeUpdate: (status) => {
      console.log('Dispute status updated:', status);
      // Add timeline event for dispute updates
      if (status.disputed && !timelineEvents.some(e => e.type === 'dispute_opened')) {
        addTimelineEvent({
          id: `dispute-opened-${Date.now()}`,
          type: 'dispute_opened',
          timestamp: Math.floor(Date.now() / 1000),
          actor: status.openedBy || 'Unknown',
          description: `Dispute opened: ${status.reason || 'No reason provided'}`,
        });
      }
    },
  });

  // Add event to timeline
  const addTimelineEvent = useCallback((event: DisputeTimelineEvent) => {
    setTimelineEvents(prev => {
      // Prevent duplicates
      if (prev.some(e => e.id === event.id)) {
        return prev;
      }
      return [...prev, event];
    });
  }, []);

  // Handle evidence upload
  const handleUploadEvidence = useCallback(async (file: File): Promise<string> => {
    try {
      // Upload to IPFS
      const cid = await uploadToIPFS(file);

      // Add CID to dispute notes via SDK
      await client.addDisputeEvidence(invoiceId, cid, file.name);

      // Add to timeline
      addTimelineEvent({
        id: `evidence-${cid}-${Date.now()}`,
        type: 'evidence_submitted',
        timestamp: Math.floor(Date.now() / 1000),
        actor: userAddress || 'Unknown',
        description: `Submitted evidence: ${file.name}`,
        metadata: {
          evidenceCid: cid,
        },
      });

      return cid;
    } catch (error) {
      console.error('Failed to upload evidence:', error);
      throw error;
    }
  }, [client, invoiceId, userAddress, uploadToIPFS, addTimelineEvent]);

  // Handle vote submission
  const handleVote = useCallback(async (approve: boolean): Promise<void> => {
    try {
      // Call SDK to submit vote
      const result = await client.voteDispute({
        invoiceId,
        arbiter: userAddress!,
        approve,
      });

      // Add to timeline
      addTimelineEvent({
        id: `vote-${Date.now()}`,
        type: 'vote_cast',
        timestamp: Math.floor(Date.now() / 1000),
        actor: userAddress || 'Unknown',
        description: `Vote cast: ${approve ? 'Approved' : 'Rejected'}`,
        metadata: {
          vote: approve ? 'approve' : 'reject',
          txHash: result.txHash,
        },
      });

      // Refresh invoice to get updated status
      await refresh();
    } catch (error) {
      console.error('Failed to submit vote:', error);
      throw error;
    }
  }, [client, invoiceId, userAddress, addTimelineEvent, refresh]);

  // Format amount for display
  const formatAmount = useCallback((amount: bigint): string => {
    return (Number(amount) / 10_000_000).toFixed(7);
  }, []);

  // Calculate total invoice amount
  const totalAmount = useMemo(() => {
    if (!invoice) return BigInt(0);
    return invoice.recipients.reduce((sum, r) => sum + r.amount, BigInt(0));
  }, [invoice]);

  // Loading state
  if (loading && !invoice) {
    return (
      <div className={`invoice-detail-page ${className}`} data-testid="invoice-detail-loading">
        <div className="invoice-detail-page__loading">
          <div className="invoice-detail-page__spinner" />
          <p>Loading invoice...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error && !invoice) {
    return (
      <div className={`invoice-detail-page ${className}`} data-testid="invoice-detail-error">
        <div className="invoice-detail-page__error">
          <h2>Error Loading Invoice</h2>
          <p>{error.message}</p>
          <button onClick={refresh} className="invoice-detail-page__retry-button">
            Retry
          </button>
        </div>
      </div>
    );
  }

  // No invoice found
  if (!invoice) {
    return (
      <div className={`invoice-detail-page ${className}`} data-testid="invoice-detail-not-found">
        <div className="invoice-detail-page__not-found">
          <h2>Invoice Not Found</h2>
          <p>Invoice #{invoiceId} does not exist or could not be loaded.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`invoice-detail-page ${className}`} data-testid="invoice-detail-page">
      {/* Connection status indicator */}
      <div className={`invoice-detail-page__status ${isConnected ? 'connected' : 'disconnected'}`}>
        <span className="invoice-detail-page__status-dot" />
        {isConnected ? 'Live' : 'Disconnected'}
      </div>

      {/* Invoice Header */}
      <div className="invoice-detail-page__header">
        <h1 className="invoice-detail-page__title">
          Invoice #{invoice.id}
        </h1>
        <span className={`invoice-detail-page__badge invoice-detail-page__badge--${invoice.status.toLowerCase()}`}>
          {invoice.status}
        </span>
      </div>

      {/* Invoice Information */}
      <div className="invoice-detail-page__info">
        <div className="invoice-detail-page__section">
          <h2 className="invoice-detail-page__section-title">Details</h2>
          
          <div className="invoice-detail-page__info-grid">
            <div className="invoice-detail-page__info-item">
              <span className="invoice-detail-page__label">Creator:</span>
              <span className="invoice-detail-page__value">{invoice.creator}</span>
            </div>

            <div className="invoice-detail-page__info-item">
              <span className="invoice-detail-page__label">Total Amount:</span>
              <span className="invoice-detail-page__value">
                {formatAmount(totalAmount)} USDC
              </span>
            </div>

            <div className="invoice-detail-page__info-item">
              <span className="invoice-detail-page__label">Funded:</span>
              <span className="invoice-detail-page__value">
                {formatAmount(invoice.funded)} USDC
              </span>
            </div>

            <div className="invoice-detail-page__info-item">
              <span className="invoice-detail-page__label">Deadline:</span>
              <span className="invoice-detail-page__value">
                {new Date(invoice.deadline * 1000).toLocaleString()}
              </span>
            </div>

            <div className="invoice-detail-page__info-item">
              <span className="invoice-detail-page__label">Recipients:</span>
              <span className="invoice-detail-page__value">
                {invoice.recipients.length}
              </span>
            </div>
          </div>
        </div>

        {/* Recipients List */}
        <div className="invoice-detail-page__section">
          <h2 className="invoice-detail-page__section-title">Recipients</h2>
          <div className="invoice-detail-page__recipients">
            {invoice.recipients.map((recipient, index) => (
              <div key={index} className="invoice-detail-page__recipient">
                <span className="invoice-detail-page__recipient-address">
                  {recipient.address}
                </span>
                <span className="invoice-detail-page__recipient-amount">
                  {formatAmount(recipient.amount)} USDC
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Dispute Panel - Only visible when invoice is disputed */}
      {disputeStatus?.disputed && (
        <div className="invoice-detail-page__section">
          <DisputePanel
            invoice={invoice}
            disputeStatus={disputeStatus}
            onUploadEvidence={handleUploadEvidence}
            onVote={handleVote}
            userAddress={userAddress}
            loading={loading}
          />
        </div>
      )}

      {/* Timeline - Show if there are events or if disputed */}
      {(timelineEvents.length > 0 || disputeStatus?.disputed) && (
        <div className="invoice-detail-page__section">
          <DisputeTimeline
            events={timelineEvents}
            loading={false}
          />
        </div>
      )}
    </div>
  );
};

export default InvoiceDetailPage;
