/**
 * Unit tests for DisputeTimeline component
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DisputeTimeline, type DisputeTimelineEvent } from '../../src/ui/DisputeTimeline.js';

describe('DisputeTimeline', () => {
  const mockEvents: DisputeTimelineEvent[] = [
    {
      id: 'event-1',
      type: 'dispute_opened',
      timestamp: 1700000000,
      actor: 'GABC...CREATOR',
      description: 'Dispute opened due to payment issue',
    },
    {
      id: 'event-2',
      type: 'evidence_submitted',
      timestamp: 1700001000,
      actor: 'GDEF...PARTY',
      description: 'Evidence document uploaded',
      metadata: {
        evidenceCid: 'QmTest123',
      },
    },
    {
      id: 'event-3',
      type: 'vote_cast',
      timestamp: 1700002000,
      actor: 'GKLM...ARBITER',
      description: 'Arbitrator cast their vote',
      metadata: {
        vote: 'approve',
        txHash: '0xabc123',
      },
    },
    {
      id: 'event-4',
      type: 'dispute_resolved',
      timestamp: 1700003000,
      actor: 'GKLM...ARBITER',
      description: 'Dispute has been resolved',
      metadata: {
        resolution: 'approved',
      },
    },
  ];

  describe('Rendering', () => {
    it('should render timeline with events', () => {
      render(<DisputeTimeline events={mockEvents} />);

      expect(screen.getByTestId('dispute-timeline')).toBeInTheDocument();
      expect(screen.getByText('Dispute Timeline')).toBeInTheDocument();
    });

    it('should render all events', () => {
      render(<DisputeTimeline events={mockEvents} />);

      expect(screen.getByTestId('timeline-event-dispute_opened')).toBeInTheDocument();
      expect(screen.getByTestId('timeline-event-evidence_submitted')).toBeInTheDocument();
      expect(screen.getByTestId('timeline-event-vote_cast')).toBeInTheDocument();
      expect(screen.getByTestId('timeline-event-dispute_resolved')).toBeInTheDocument();
    });

    it('should display event descriptions', () => {
      render(<DisputeTimeline events={mockEvents} />);

      expect(screen.getByText('Dispute opened due to payment issue')).toBeInTheDocument();
      expect(screen.getByText('Evidence document uploaded')).toBeInTheDocument();
      expect(screen.getByText('Arbitrator cast their vote')).toBeInTheDocument();
      expect(screen.getByText('Dispute has been resolved')).toBeInTheDocument();
    });

    it('should show loading state', () => {
      render(<DisputeTimeline events={[]} loading={true} />);

      expect(screen.getByTestId('dispute-timeline-loading')).toBeInTheDocument();
      expect(screen.getByText('Loading timeline...')).toBeInTheDocument();
    });

    it('should show empty state when no events', () => {
      render(<DisputeTimeline events={[]} />);

      expect(screen.getByTestId('dispute-timeline-empty')).toBeInTheDocument();
      expect(screen.getByText('No events yet')).toBeInTheDocument();
    });

    it('should apply custom className', () => {
      const { container } = render(
        <DisputeTimeline events={mockEvents} className="custom-class" />
      );

      const timeline = container.querySelector('.dispute-timeline');
      expect(timeline?.classList.contains('custom-class')).toBe(true);
    });
  });

  describe('Event Sorting', () => {
    it('should sort events by timestamp (newest first)', () => {
      const unsortedEvents: DisputeTimelineEvent[] = [
        {
          id: 'event-old',
          type: 'dispute_opened',
          timestamp: 1700000000,
          actor: 'GABC...CREATOR',
          description: 'Old event',
        },
        {
          id: 'event-newest',
          type: 'evidence_submitted',
          timestamp: 1700003000,
          actor: 'GDEF...PARTY',
          description: 'Newest event',
        },
        {
          id: 'event-middle',
          type: 'vote_cast',
          timestamp: 1700001000,
          actor: 'GKLM...ARBITER',
          description: 'Middle event',
        },
      ];

      render(<DisputeTimeline events={unsortedEvents} />);

      const events = screen.getAllByText(/event/);
      expect(events[0]).toHaveTextContent('Newest event');
      expect(events[1]).toHaveTextContent('Middle event');
      expect(events[2]).toHaveTextContent('Old event');
    });
  });

  describe('Event Icons', () => {
    it('should display correct icon for each event type', () => {
      render(<DisputeTimeline events={mockEvents} />);

      const timeline = screen.getByTestId('dispute-timeline');
      expect(timeline).toHaveTextContent('⚠️'); // dispute_opened
      expect(timeline).toHaveTextContent('📎'); // evidence_submitted
      expect(timeline).toHaveTextContent('🗳️'); // vote_cast
      expect(timeline).toHaveTextContent('✅'); // dispute_resolved
    });
  });

  describe('Actor Display', () => {
    it('should display actor addresses truncated', () => {
      render(<DisputeTimeline events={mockEvents} />);

      // Addresses are truncated as first6...last4
      expect(screen.getByText('GABC.....ATOR')).toBeInTheDocument();
      expect(screen.getByText('GDEF...PARTY')).toBeInTheDocument();
    });

    it('should show full address in title attribute', () => {
      render(<DisputeTimeline events={mockEvents} />);

      const actorElement = screen.getByTitle('GABC...CREATOR');
      expect(actorElement).toBeInTheDocument();
    });
  });

  describe('Metadata Display', () => {
    it('should display evidence CID when available', () => {
      render(<DisputeTimeline events={mockEvents} />);

      expect(screen.getByText('Evidence CID:')).toBeInTheDocument();
      expect(screen.getByText('QmTest123')).toBeInTheDocument();
    });

    it('should display vote information when available', () => {
      render(<DisputeTimeline events={mockEvents} />);

      expect(screen.getByText('Vote:')).toBeInTheDocument();
      expect(screen.getByText('✓ Approved')).toBeInTheDocument();
    });

    it('should display resolution information when available', () => {
      render(<DisputeTimeline events={mockEvents} />);

      expect(screen.getByText('Resolution:')).toBeInTheDocument();
      expect(screen.getByText('Release Approved')).toBeInTheDocument();
    });

    it('should display transaction hash when available', () => {
      render(<DisputeTimeline events={mockEvents} />);

      expect(screen.getByText('Transaction:')).toBeInTheDocument();
      // Transaction hash is not truncated if less than 12 chars, so it shows full hash
      expect(screen.getByText('0xabc123')).toBeInTheDocument();
    });

    it('should handle events without metadata', () => {
      const eventsWithoutMetadata: DisputeTimelineEvent[] = [
        {
          id: 'simple-event',
          type: 'dispute_opened',
          timestamp: 1700000000,
          actor: 'GABC...CREATOR',
          description: 'Simple event without metadata',
        },
      ];

      render(<DisputeTimeline events={eventsWithoutMetadata} />);

      expect(screen.queryByText('Evidence CID:')).not.toBeInTheDocument();
      expect(screen.queryByText('Vote:')).not.toBeInTheDocument();
    });
  });

  describe('Event Type Formatting', () => {
    it('should format event types as human-readable text', () => {
      render(<DisputeTimeline events={mockEvents} />);

      expect(screen.getByText('Dispute Opened')).toBeInTheDocument();
      expect(screen.getByText('Evidence Submitted')).toBeInTheDocument();
      expect(screen.getByText('Vote Cast')).toBeInTheDocument();
      expect(screen.getByText('Dispute Resolved')).toBeInTheDocument();
    });
  });

  describe('Timestamp Formatting', () => {
    it('should display relative time for recent events', () => {
      const recentEvent: DisputeTimelineEvent = {
        id: 'recent',
        type: 'evidence_submitted',
        timestamp: Math.floor(Date.now() / 1000) - 300, // 5 minutes ago
        actor: 'GABC...CREATOR',
        description: 'Recent event',
      };

      render(<DisputeTimeline events={[recentEvent]} />);

      expect(screen.getByText(/minute.*ago/)).toBeInTheDocument();
    });

    it('should display "just now" for very recent events', () => {
      const veryRecentEvent: DisputeTimelineEvent = {
        id: 'very-recent',
        type: 'evidence_submitted',
        timestamp: Math.floor(Date.now() / 1000) - 10, // 10 seconds ago
        actor: 'GABC...CREATOR',
        description: 'Very recent event',
      };

      render(<DisputeTimeline events={[veryRecentEvent]} />);

      expect(screen.getByText('just now')).toBeInTheDocument();
    });

    it('should display absolute date for old events', () => {
      const oldEvent: DisputeTimelineEvent = {
        id: 'old',
        type: 'dispute_opened',
        timestamp: 1600000000, // September 2020
        actor: 'GABC...CREATOR',
        description: 'Old event',
      };

      render(<DisputeTimeline events={[oldEvent]} />);

      // Should display month and date
      const timeline = screen.getByTestId('dispute-timeline');
      expect(timeline.textContent).toMatch(/Sep/);
    });
  });

  describe('Vote Badge Display', () => {
    it('should show approved badge with checkmark', () => {
      const approveEvent: DisputeTimelineEvent = {
        id: 'approve',
        type: 'vote_cast',
        timestamp: 1700000000,
        actor: 'GKLM...ARBITER',
        description: 'Vote cast',
        metadata: { vote: 'approve' },
      };

      render(<DisputeTimeline events={[approveEvent]} />);

      expect(screen.getByText('✓ Approved')).toBeInTheDocument();
    });

    it('should show rejected badge with cross', () => {
      const rejectEvent: DisputeTimelineEvent = {
        id: 'reject',
        type: 'vote_cast',
        timestamp: 1700000000,
        actor: 'GKLM...ARBITER',
        description: 'Vote cast',
        metadata: { vote: 'reject' },
      };

      render(<DisputeTimeline events={[rejectEvent]} />);

      expect(screen.getByText('✗ Rejected')).toBeInTheDocument();
    });
  });

  describe('Resolution Badge Display', () => {
    it('should show resolution as approved', () => {
      const resolvedEvent: DisputeTimelineEvent = {
        id: 'resolved-approve',
        type: 'dispute_resolved',
        timestamp: 1700000000,
        actor: 'GKLM...ARBITER',
        description: 'Resolved',
        metadata: { resolution: 'approved' },
      };

      render(<DisputeTimeline events={[resolvedEvent]} />);

      expect(screen.getByText('Release Approved')).toBeInTheDocument();
    });

    it('should show resolution as rejected', () => {
      const resolvedEvent: DisputeTimelineEvent = {
        id: 'resolved-reject',
        type: 'dispute_resolved',
        timestamp: 1700000000,
        actor: 'GKLM...ARBITER',
        description: 'Resolved',
        metadata: { resolution: 'rejected' },
      };

      render(<DisputeTimeline events={[resolvedEvent]} />);

      expect(screen.getByText('Refund Initiated')).toBeInTheDocument();
    });
  });

  describe('Timeline Connector', () => {
    it('should show connectors between events', () => {
      const { container } = render(<DisputeTimeline events={mockEvents} />);

      const connectors = container.querySelectorAll('.dispute-timeline__connector');
      // Should have N-1 connectors for N events
      expect(connectors.length).toBe(mockEvents.length - 1);
    });

    it('should not show connector for last event', () => {
      render(<DisputeTimeline events={[mockEvents[0]!]} />);

      const { container } = render(<DisputeTimeline events={[mockEvents[0]!]} />);
      const connectors = container.querySelectorAll('.dispute-timeline__connector');
      expect(connectors.length).toBe(0);
    });
  });
});
