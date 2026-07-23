/**
 * Unit tests for DisputePanel component
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DisputePanel } from '../../src/ui/DisputePanel.js';
import type { Invoice, DisputeStatus } from '../../src/types.js';

describe('DisputePanel', () => {
  const mockInvoice: Invoice = {
    id: '123',
    creator: 'GABC...CREATOR',
    recipients: [
      { address: 'GDEF...RECIPIENT1', amount: BigInt(60_000_000) },
      { address: 'GHIJ...RECIPIENT2', amount: BigInt(40_000_000) },
    ],
    token: 'USDC_CONTRACT',
    deadline: Math.floor(Date.now() / 1000) + 86400,
    funded: BigInt(100_000_000),
    status: 'Disputed',
    payments: [],
  };

  const mockDisputeStatus: DisputeStatus = {
    invoiceId: '123',
    disputed: true,
    arbiter: 'GKLM...ARBITER',
    resolved: false,
    resolution: null,
    reason: 'Payment dispute',
    openedBy: 'GABC...CREATOR',
    openedAt: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
  };

  const mockOnUploadEvidence = vi.fn();
  const mockOnVote = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('should render dispute panel when dispute is active', () => {
      render(
        <DisputePanel
          invoice={mockInvoice}
          disputeStatus={mockDisputeStatus}
          onUploadEvidence={mockOnUploadEvidence}
          onVote={mockOnVote}
        />
      );

      expect(screen.getByTestId('dispute-panel')).toBeInTheDocument();
      expect(screen.getByText('⚠️ Dispute in Progress')).toBeInTheDocument();
    });

    it('should not render when dispute is not active', () => {
      const nonDisputedStatus = { ...mockDisputeStatus, disputed: false };
      
      const { container } = render(
        <DisputePanel
          invoice={mockInvoice}
          disputeStatus={nonDisputedStatus}
          onUploadEvidence={mockOnUploadEvidence}
          onVote={mockOnVote}
        />
      );

      expect(container.firstChild).toBeNull();
    });

    it('should display dispute information correctly', () => {
      render(
        <DisputePanel
          invoice={mockInvoice}
          disputeStatus={mockDisputeStatus}
          onUploadEvidence={mockOnUploadEvidence}
          onVote={mockOnVote}
        />
      );

      expect(screen.getByText('Payment dispute')).toBeInTheDocument();
      expect(screen.getByText('GABC...CREATOR')).toBeInTheDocument();
      expect(screen.getByText('GKLM...ARBITER')).toBeInTheDocument();
    });

    it('should show active status badge for unresolved disputes', () => {
      render(
        <DisputePanel
          invoice={mockInvoice}
          disputeStatus={mockDisputeStatus}
          onUploadEvidence={mockOnUploadEvidence}
          onVote={mockOnVote}
        />
      );

      const statusBadge = screen.getByText('Active');
      expect(statusBadge).toBeInTheDocument();
      expect(statusBadge.className).toContain('active');
    });

    it('should show resolved status for resolved disputes', () => {
      const resolvedStatus = {
        ...mockDisputeStatus,
        resolved: true,
        resolution: 'approved' as const,
      };

      render(
        <DisputePanel
          invoice={mockInvoice}
          disputeStatus={resolvedStatus}
          onUploadEvidence={mockOnUploadEvidence}
          onVote={mockOnVote}
        />
      );

      expect(screen.getByText('Resolved')).toBeInTheDocument();
      expect(screen.getByText('Dispute Approved - Funds will be released')).toBeInTheDocument();
    });
  });

  describe('Evidence Upload', () => {
    it('should allow file selection', async () => {
      render(
        <DisputePanel
          invoice={mockInvoice}
          disputeStatus={mockDisputeStatus}
          onUploadEvidence={mockOnUploadEvidence}
          onVote={mockOnVote}
        />
      );

      const fileInput = screen.getByTestId('evidence-file-input') as HTMLInputElement;
      const file = new File(['evidence content'], 'evidence.pdf', { type: 'application/pdf' });

      await userEvent.upload(fileInput, file);

      expect(fileInput.files?.[0]).toBe(file);
      expect(screen.getByText('evidence.pdf')).toBeInTheDocument();
    });

    it('should reject files larger than 10MB', async () => {
      render(
        <DisputePanel
          invoice={mockInvoice}
          disputeStatus={mockDisputeStatus}
          onUploadEvidence={mockOnUploadEvidence}
          onVote={mockOnVote}
        />
      );

      const fileInput = screen.getByTestId('evidence-file-input') as HTMLInputElement;
      // Create a file larger than 10MB
      const largeFile = new File(['x'.repeat(11 * 1024 * 1024)], 'large.pdf', { type: 'application/pdf' });

      await userEvent.upload(fileInput, largeFile);

      await waitFor(() => {
        expect(screen.getByText('File size must be less than 10MB')).toBeInTheDocument();
      });
    });

    it('should call onUploadEvidence when upload button is clicked', async () => {
      mockOnUploadEvidence.mockResolvedValue('QmTest123CID');

      render(
        <DisputePanel
          invoice={mockInvoice}
          disputeStatus={mockDisputeStatus}
          onUploadEvidence={mockOnUploadEvidence}
          onVote={mockOnVote}
        />
      );

      const fileInput = screen.getByTestId('evidence-file-input') as HTMLInputElement;
      const file = new File(['evidence'], 'evidence.pdf', { type: 'application/pdf' });

      await userEvent.upload(fileInput, file);

      const uploadButton = screen.getByTestId('upload-evidence-button');
      await userEvent.click(uploadButton);

      await waitFor(() => {
        expect(mockOnUploadEvidence).toHaveBeenCalledWith(file);
      });
    });

    it('should show success message after successful upload', async () => {
      mockOnUploadEvidence.mockResolvedValue('QmTest123CID');

      render(
        <DisputePanel
          invoice={mockInvoice}
          disputeStatus={mockDisputeStatus}
          onUploadEvidence={mockOnUploadEvidence}
          onVote={mockOnVote}
        />
      );

      const fileInput = screen.getByTestId('evidence-file-input') as HTMLInputElement;
      const file = new File(['evidence'], 'evidence.pdf', { type: 'application/pdf' });

      await userEvent.upload(fileInput, file);

      const uploadButton = screen.getByTestId('upload-evidence-button');
      await userEvent.click(uploadButton);

      await waitFor(() => {
        expect(screen.getByTestId('success-message')).toHaveTextContent('Evidence uploaded successfully');
        expect(screen.getByTestId('success-message')).toHaveTextContent('QmTest123CID');
      });
    });

    it('should show error message on upload failure', async () => {
      mockOnUploadEvidence.mockRejectedValue(new Error('IPFS upload failed'));

      render(
        <DisputePanel
          invoice={mockInvoice}
          disputeStatus={mockDisputeStatus}
          onUploadEvidence={mockOnUploadEvidence}
          onVote={mockOnVote}
        />
      );

      const fileInput = screen.getByTestId('evidence-file-input') as HTMLInputElement;
      const file = new File(['evidence'], 'evidence.pdf', { type: 'application/pdf' });

      await userEvent.upload(fileInput, file);

      const uploadButton = screen.getByTestId('upload-evidence-button');
      await userEvent.click(uploadButton);

      await waitFor(() => {
        expect(screen.getByTestId('error-message')).toHaveTextContent('IPFS upload failed');
      });
    });

    it('should disable upload button when no file is selected', () => {
      render(
        <DisputePanel
          invoice={mockInvoice}
          disputeStatus={mockDisputeStatus}
          onUploadEvidence={mockOnUploadEvidence}
          onVote={mockOnVote}
        />
      );

      const uploadButton = screen.getByTestId('upload-evidence-button') as HTMLButtonElement;
      expect(uploadButton.disabled).toBe(true);
    });

    it('should not show upload section for resolved disputes', () => {
      const resolvedStatus = {
        ...mockDisputeStatus,
        resolved: true,
        resolution: 'approved' as const,
      };

      render(
        <DisputePanel
          invoice={mockInvoice}
          disputeStatus={resolvedStatus}
          onUploadEvidence={mockOnUploadEvidence}
          onVote={mockOnVote}
        />
      );

      expect(screen.queryByTestId('evidence-file-input')).not.toBeInTheDocument();
      expect(screen.queryByTestId('upload-evidence-button')).not.toBeInTheDocument();
    });
  });

  describe('Arbitrator Voting', () => {
    it('should show voting buttons for arbitrators', () => {
      render(
        <DisputePanel
          invoice={mockInvoice}
          disputeStatus={mockDisputeStatus}
          onUploadEvidence={mockOnUploadEvidence}
          onVote={mockOnVote}
          userAddress="GKLM...ARBITER"
        />
      );

      expect(screen.getByTestId('vote-approve-button')).toBeInTheDocument();
      expect(screen.getByTestId('vote-reject-button')).toBeInTheDocument();
      expect(screen.getByText('✓ Approve Release')).toBeInTheDocument();
      expect(screen.getByText('✗ Reject (Refund)')).toBeInTheDocument();
    });

    it('should not show voting buttons for non-arbitrators', () => {
      render(
        <DisputePanel
          invoice={mockInvoice}
          disputeStatus={mockDisputeStatus}
          onUploadEvidence={mockOnUploadEvidence}
          onVote={mockOnVote}
          userAddress="GNON...ARBITRATOR"
        />
      );

      expect(screen.queryByTestId('vote-approve-button')).not.toBeInTheDocument();
      expect(screen.queryByTestId('vote-reject-button')).not.toBeInTheDocument();
      expect(screen.getByText('Only the assigned arbitrator can vote on this dispute.')).toBeInTheDocument();
    });

    it('should call onVote with true when approve button is clicked', async () => {
      mockOnVote.mockResolvedValue(undefined);

      render(
        <DisputePanel
          invoice={mockInvoice}
          disputeStatus={mockDisputeStatus}
          onUploadEvidence={mockOnUploadEvidence}
          onVote={mockOnVote}
          userAddress="GKLM...ARBITER"
        />
      );

      const approveButton = screen.getByTestId('vote-approve-button');
      await userEvent.click(approveButton);

      await waitFor(() => {
        expect(mockOnVote).toHaveBeenCalledWith(true);
      });
    });

    it('should call onVote with false when reject button is clicked', async () => {
      mockOnVote.mockResolvedValue(undefined);

      render(
        <DisputePanel
          invoice={mockInvoice}
          disputeStatus={mockDisputeStatus}
          onUploadEvidence={mockOnUploadEvidence}
          onVote={mockOnVote}
          userAddress="GKLM...ARBITER"
        />
      );

      const rejectButton = screen.getByTestId('vote-reject-button');
      await userEvent.click(rejectButton);

      await waitFor(() => {
        expect(mockOnVote).toHaveBeenCalledWith(false);
      });
    });

    it('should show success message after successful vote', async () => {
      mockOnVote.mockResolvedValue(undefined);

      render(
        <DisputePanel
          invoice={mockInvoice}
          disputeStatus={mockDisputeStatus}
          onUploadEvidence={mockOnUploadEvidence}
          onVote={mockOnVote}
          userAddress="GKLM...ARBITER"
        />
      );

      const approveButton = screen.getByTestId('vote-approve-button');
      await userEvent.click(approveButton);

      await waitFor(() => {
        expect(screen.getByTestId('success-message')).toHaveTextContent('Vote cast successfully: Approved');
      });
    });

    it('should show error message on vote failure', async () => {
      mockOnVote.mockRejectedValue(new Error('Transaction failed'));

      render(
        <DisputePanel
          invoice={mockInvoice}
          disputeStatus={mockDisputeStatus}
          onUploadEvidence={mockOnUploadEvidence}
          onVote={mockOnVote}
          userAddress="GKLM...ARBITER"
        />
      );

      const approveButton = screen.getByTestId('vote-approve-button');
      await userEvent.click(approveButton);

      await waitFor(() => {
        expect(screen.getByTestId('error-message')).toHaveTextContent('Transaction failed');
      });
    });

    it('should disable vote buttons while voting', async () => {
      mockOnVote.mockImplementation(() => new Promise(resolve => setTimeout(resolve, 100)));

      render(
        <DisputePanel
          invoice={mockInvoice}
          disputeStatus={mockDisputeStatus}
          onUploadEvidence={mockOnUploadEvidence}
          onVote={mockOnVote}
          userAddress="GKLM...ARBITER"
        />
      );

      const approveButton = screen.getByTestId('vote-approve-button') as HTMLButtonElement;
      const rejectButton = screen.getByTestId('vote-reject-button') as HTMLButtonElement;

      await userEvent.click(approveButton);

      // Buttons should be disabled while voting
      expect(approveButton.disabled).toBe(true);
      expect(rejectButton.disabled).toBe(true);
    });

    it('should not show voting buttons for resolved disputes', () => {
      const resolvedStatus = {
        ...mockDisputeStatus,
        resolved: true,
        resolution: 'approved' as const,
      };

      render(
        <DisputePanel
          invoice={mockInvoice}
          disputeStatus={resolvedStatus}
          onUploadEvidence={mockOnUploadEvidence}
          onVote={mockOnVote}
          userAddress="GKLM...ARBITER"
        />
      );

      expect(screen.queryByTestId('vote-approve-button')).not.toBeInTheDocument();
      expect(screen.queryByTestId('vote-reject-button')).not.toBeInTheDocument();
    });

    it('should show "You" badge for current arbitrator', () => {
      render(
        <DisputePanel
          invoice={mockInvoice}
          disputeStatus={mockDisputeStatus}
          onUploadEvidence={mockOnUploadEvidence}
          onVote={mockOnVote}
          userAddress="GKLM...ARBITER"
        />
      );

      expect(screen.getByText('You')).toBeInTheDocument();
    });
  });

  describe('Time Display', () => {
    it('should format time since dispute opened correctly', () => {
      const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
      const statusWithTime = { ...mockDisputeStatus, openedAt: oneHourAgo };

      render(
        <DisputePanel
          invoice={mockInvoice}
          disputeStatus={statusWithTime}
          onUploadEvidence={mockOnUploadEvidence}
          onVote={mockOnVote}
        />
      );

      expect(screen.getByText(/1 hour ago/)).toBeInTheDocument();
    });

    it('should handle missing timestamp gracefully', () => {
      const statusWithoutTime = { ...mockDisputeStatus, openedAt: undefined };

      render(
        <DisputePanel
          invoice={mockInvoice}
          disputeStatus={statusWithoutTime}
          onUploadEvidence={mockOnUploadEvidence}
          onVote={mockOnVote}
        />
      );

      expect(screen.getByText('Unknown')).toBeInTheDocument();
    });
  });

  describe('Loading State', () => {
    it('should disable all buttons when loading', () => {
      render(
        <DisputePanel
          invoice={mockInvoice}
          disputeStatus={mockDisputeStatus}
          onUploadEvidence={mockOnUploadEvidence}
          onVote={mockOnVote}
          userAddress="GKLM...ARBITER"
          loading={true}
        />
      );

      const approveButton = screen.getByTestId('vote-approve-button') as HTMLButtonElement;
      const rejectButton = screen.getByTestId('vote-reject-button') as HTMLButtonElement;
      const uploadButton = screen.getByTestId('upload-evidence-button') as HTMLButtonElement;

      expect(approveButton.disabled).toBe(true);
      expect(rejectButton.disabled).toBe(true);
      expect(uploadButton.disabled).toBe(true);
    });
  });
});
