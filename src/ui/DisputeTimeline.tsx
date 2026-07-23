/**
 * DisputeTimeline Component
 * 
 * Displays chronological timeline of dispute lifecycle events
 * 
 * @module ui/DisputeTimeline
 */

import React from 'react';

export type DisputeEventType =
  | 'dispute_opened'
  | 'evidence_submitted'
  | 'vote_cast'
  | 'dispute_resolved'
  | 'dispute_escalated';

export interface DisputeTimelineEvent {
  /** Unique event ID */
  id: string;
  /** Type of event */
  type: DisputeEventType;
  /** Event timestamp (Unix seconds) */
  timestamp: number;
  /** Actor who triggered the event */
  actor: string;
  /** Event description/details */
  description: string;
  /** Additional metadata */
  metadata?: {
    /** For evidence_submitted: IPFS CID */
    evidenceCid?: string;
    /** For vote_cast: vote decision */
    vote?: 'approve' | 'reject';
    /** For dispute_resolved: final resolution */
    resolution?: 'approved' | 'rejected';
    /** Transaction hash */
    txHash?: string;
  };
}

export interface DisputeTimelineProps {
  /** Array of timeline events in any order (will be sorted) */
  events: DisputeTimelineEvent[];
  /** Whether to show loading state */
  loading?: boolean;
  /** CSS class name for custom styling */
  className?: string;
}

/**
 * DisputeTimeline - Chronological event display
 * 
 * Features:
 * - Automatically sorts events by timestamp (newest first)
 * - Visual timeline with icons for different event types
 * - Displays actor, timestamp, and event details
 * - Supports metadata like evidence CIDs and vote decisions
 */
export const DisputeTimeline: React.FC<DisputeTimelineProps> = ({
  events,
  loading = false,
  className = '',
}) => {
  // Sort events by timestamp (newest first)
  const sortedEvents = [...events].sort((a, b) => b.timestamp - a.timestamp);

  // Get icon for event type
  const getEventIcon = (type: DisputeEventType): string => {
    switch (type) {
      case 'dispute_opened':
        return '⚠️';
      case 'evidence_submitted':
        return '📎';
      case 'vote_cast':
        return '🗳️';
      case 'dispute_resolved':
        return '✅';
      case 'dispute_escalated':
        return '⬆️';
      default:
        return '•';
    }
  };

  // Get color class for event type
  const getEventColor = (type: DisputeEventType): string => {
    switch (type) {
      case 'dispute_opened':
        return 'warning';
      case 'evidence_submitted':
        return 'info';
      case 'vote_cast':
        return 'primary';
      case 'dispute_resolved':
        return 'success';
      case 'dispute_escalated':
        return 'danger';
      default:
        return 'neutral';
    }
  };

  // Format timestamp to readable date/time
  const formatTimestamp = (timestamp: number): string => {
    const date = new Date(timestamp * 1000);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    // Relative time for recent events
    if (seconds < 60) return 'just now';
    if (minutes < 60) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    if (days < 7) return `${days} day${days > 1 ? 's' : ''} ago`;

    // Absolute date for older events
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // Truncate address for display
  const truncateAddress = (address: string): string => {
    if (address.length <= 12) return address;
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  };

  // Format event type as human-readable text
  const formatEventType = (type: DisputeEventType): string => {
    return type
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  };

  if (loading) {
    return (
      <div className={`dispute-timeline ${className}`} data-testid="dispute-timeline-loading">
        <div className="dispute-timeline__loading">
          <div className="dispute-timeline__spinner" />
          <p>Loading timeline...</p>
        </div>
      </div>
    );
  }

  if (sortedEvents.length === 0) {
    return (
      <div className={`dispute-timeline ${className}`} data-testid="dispute-timeline-empty">
        <div className="dispute-timeline__empty">
          <p>No events yet</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`dispute-timeline ${className}`} data-testid="dispute-timeline">
      <h3 className="dispute-timeline__title">Dispute Timeline</h3>
      
      <div className="dispute-timeline__events">
        {sortedEvents.map((event, index) => (
          <div
            key={event.id}
            className={`dispute-timeline__event dispute-timeline__event--${getEventColor(event.type)}`}
            data-testid={`timeline-event-${event.type}`}
          >
            {/* Timeline line connector */}
            {index < sortedEvents.length - 1 && (
              <div className="dispute-timeline__connector" />
            )}

            {/* Event icon */}
            <div className="dispute-timeline__icon">
              <span className="dispute-timeline__icon-emoji">
                {getEventIcon(event.type)}
              </span>
            </div>

            {/* Event content */}
            <div className="dispute-timeline__content">
              {/* Event header */}
              <div className="dispute-timeline__header">
                <span className="dispute-timeline__type">
                  {formatEventType(event.type)}
                </span>
                <span className="dispute-timeline__timestamp">
                  {formatTimestamp(event.timestamp)}
                </span>
              </div>

              {/* Event description */}
              <p className="dispute-timeline__description">
                {event.description}
              </p>

              {/* Event actor */}
              <div className="dispute-timeline__actor">
                <span className="dispute-timeline__actor-label">By:</span>
                <span className="dispute-timeline__actor-address" title={event.actor}>
                  {truncateAddress(event.actor)}
                </span>
              </div>

              {/* Event metadata */}
              {event.metadata && (
                <div className="dispute-timeline__metadata">
                  {event.metadata.evidenceCid && (
                    <div className="dispute-timeline__metadata-item">
                      <span className="dispute-timeline__metadata-label">Evidence CID:</span>
                      <code className="dispute-timeline__metadata-value">
                        {event.metadata.evidenceCid}
                      </code>
                    </div>
                  )}

                  {event.metadata.vote && (
                    <div className="dispute-timeline__metadata-item">
                      <span className="dispute-timeline__metadata-label">Vote:</span>
                      <span className={`dispute-timeline__vote-badge dispute-timeline__vote-badge--${event.metadata.vote}`}>
                        {event.metadata.vote === 'approve' ? '✓ Approved' : '✗ Rejected'}
                      </span>
                    </div>
                  )}

                  {event.metadata.resolution && (
                    <div className="dispute-timeline__metadata-item">
                      <span className="dispute-timeline__metadata-label">Resolution:</span>
                      <span className={`dispute-timeline__resolution-badge dispute-timeline__resolution-badge--${event.metadata.resolution}`}>
                        {event.metadata.resolution === 'approved' ? 'Release Approved' : 'Refund Initiated'}
                      </span>
                    </div>
                  )}

                  {event.metadata.txHash && (
                    <div className="dispute-timeline__metadata-item">
                      <span className="dispute-timeline__metadata-label">Transaction:</span>
                      <code className="dispute-timeline__metadata-value dispute-timeline__tx-hash">
                        {truncateAddress(event.metadata.txHash)}
                      </code>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default DisputeTimeline;
