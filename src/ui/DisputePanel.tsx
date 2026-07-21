/**
 * DisputePanel Component
 * 
 * Displays dispute information, evidence submission, and arbitrator voting
 * for invoices in "Disputed" status.
 * 
 * @module ui/DisputePanel
 */

import React, { useState, useCallback } from 'react';
import type { Invoice, DisputeStatus } from '../types.js';

export interface DisputePanelProps {
  /** The invoice with dispute information */
  invoice: Invoice;
  /** Current dispute status from the contract */
  disputeStatus: DisputeStatus;
  /** Callback to upload evidence file to IPFS */
  onUploadEvidence: (file: File) => Promise<string>;
  /** Callback to submit vote (approve or reject) */
  onVote: (approve: boolean) => Promise<void>;
  /** Current user's wallet address */
  userAddress?: string;
  /** Whether the component is loading */
  loading?: boolean;
}

export interface DisputeEvidenceItem {
  cid: string;
  uploadedBy: string;
  uploadedAt: number;
  fileName?: string;
}

/**
 * DisputePanel - Main dispute UI component
 * 
 * Features:
 * - Displays dispute information (reason, opener, time, arbitrators)
 * - Shows current vote tally
 * - Allows evidence upload to IPFS
 * - Provides voting buttons for arbitrators
 * - Real-time updates via props
 */
export const DisputePanel: React.FC<DisputePanelProps> = ({
  invoice,
  disputeStatus,
  onUploadEvidence,
  onVote,
  userAddress,
  loading = false,
}) => {
  const [uploadingEvidence, setUploadingEvidence] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [votingAction, setVotingAction] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Check if current user is an arbitrator
  const isArbitrator = userAddress && disputeStatus.arbiter === userAddress;

  // Check if dispute is still active (not resolved)
  const isDisputeActive = disputeStatus.disputed && !disputeStatus.resolved;

  // Handle file selection
  const handleFileSelect = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      // Validate file size (max 10MB)
      if (file.size > 10 * 1024 * 1024) {
        setError('File size must be less than 10MB');
        return;
      }
      setSelectedFile(file);
      setError(null);
    }
  }, []);

  // Handle evidence upload
  const handleUploadEvidence = useCallback(async () => {
    if (!selectedFile) {
      setError('Please select a file to upload');
      return;
    }

    setUploadingEvidence(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const cid = await onUploadEvidence(selectedFile);
      setSuccessMessage(`Evidence uploaded successfully. IPFS CID: ${cid}`);
      setSelectedFile(null);
      
      // Reset file input
      const fileInput = document.getElementById('evidence-file-input') as HTMLInputElement;
      if (fileInput) {
        fileInput.value = '';
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload evidence');
    } finally {
      setUploadingEvidence(false);
    }
  }, [selectedFile, onUploadEvidence]);

  // Handle vote submission
  const handleVote = useCallback(async (approve: boolean) => {
    if (!isArbitrator) {
      setError('Only the assigned arbitrator can vote');
      return;
    }

    if (!isDisputeActive) {
      setError('This dispute has already been resolved');
      return;
    }

    setVotingAction(approve ? 'approve' : 'reject');
    setError(null);
    setSuccessMessage(null);

    try {
      await onVote(approve);
      setSuccessMessage(`Vote cast successfully: ${approve ? 'Approved' : 'Rejected'}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit vote');
    } finally {
      setVotingAction(null);
    }
  }, [isArbitrator, isDisputeActive, onVote]);

  // Format timestamp to readable date
  const formatDate = (timestamp: number): string => {
    return new Date(timestamp * 1000).toLocaleString();
  };

  // Calculate time since dispute opened
  const getTimeSinceOpened = (): string => {
    const now = Math.floor(Date.now() / 1000);
    const diff = now - (disputeStatus.openedAt || 0);
    
    const days = Math.floor(diff / 86400);
    const hours = Math.floor((diff % 86400) / 3600);
    const minutes = Math.floor((diff % 3600) / 60);

    if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
    if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  };

  if (!disputeStatus.disputed) {
    return null;
  }

  return (
    <div className="dispute-panel" data-testid="dispute-panel">
      {/* Header */}
      <div className="dispute-panel__header">
        <h2 className="dispute-panel__title">
          ⚠️ Dispute in Progress
        </h2>
        <span className={`dispute-panel__status ${isDisputeActive ? 'active' : 'resolved'}`}>
          {isDisputeActive ? 'Active' : 'Resolved'}
        </span>
      </div>

      {/* Dispute Information */}
      <div className="dispute-panel__info">
        <div className="dispute-panel__info-grid">
          <div className="dispute-panel__info-item">
            <span className="dispute-panel__label">Dispute Reason:</span>
            <span className="dispute-panel__value">{disputeStatus.reason || 'Not specified'}</span>
          </div>

          <div className="dispute-panel__info-item">
            <span className="dispute-panel__label">Opened By:</span>
            <span className="dispute-panel__value dispute-panel__address">
              {disputeStatus.openedBy || 'Unknown'}
            </span>
          </div>

          <div className="dispute-panel__info-item">
            <span className="dispute-panel__label">Time Opened:</span>
            <span className="dispute-panel__value">
              {disputeStatus.openedAt ? formatDate(disputeStatus.openedAt) : 'Unknown'}
              {disputeStatus.openedAt && (
                <span className="dispute-panel__time-ago"> ({getTimeSinceOpened()})</span>
              )}
            </span>
          </div>

          <div className="dispute-panel__info-item">
            <span className="dispute-panel__label">Arbitrator:</span>
            <span className="dispute-panel__value dispute-panel__address">
              {disputeStatus.arbiter}
              {isArbitrator && (
                <span className="dispute-panel__badge">You</span>
              )}
            </span>
          </div>
        </div>
      </div>

      {/* Vote Tally */}
      {disputeStatus.resolved && (
        <div className="dispute-panel__vote-tally">
          <h3 className="dispute-panel__section-title">Final Decision</h3>
          <div className={`dispute-panel__result ${disputeStatus.resolution}`}>
            <div className="dispute-panel__result-icon">
              {disputeStatus.resolution === 'approved' ? '✓' : '✗'}
            </div>
            <div className="dispute-panel__result-text">
              {disputeStatus.resolution === 'approved' 
                ? 'Dispute Approved - Funds will be released' 
                : 'Dispute Rejected - Funds will be refunded'}
            </div>
          </div>
        </div>
      )}

      {/* Evidence Upload Section */}
      {isDisputeActive && (
        <div className="dispute-panel__evidence">
          <h3 className="dispute-panel__section-title">Submit Evidence</h3>
          <p className="dispute-panel__description">
            Upload documents or evidence to support your case. Files will be stored on IPFS.
          </p>

          <div className="dispute-panel__upload">
            <input
              id="evidence-file-input"
              type="file"
              onChange={handleFileSelect}
              disabled={uploadingEvidence || loading}
              className="dispute-panel__file-input"
              accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.txt"
              data-testid="evidence-file-input"
            />

            {selectedFile && (
              <div className="dispute-panel__selected-file">
                <span className="dispute-panel__file-name">{selectedFile.name}</span>
                <span className="dispute-panel__file-size">
                  ({(selectedFile.size / 1024).toFixed(1)} KB)
                </span>
              </div>
            )}

            <button
              onClick={handleUploadEvidence}
              disabled={!selectedFile || uploadingEvidence || loading}
              className="dispute-panel__button dispute-panel__button--upload"
              data-testid="upload-evidence-button"
            >
              {uploadingEvidence ? 'Uploading...' : 'Submit Evidence'}
            </button>
          </div>
        </div>
      )}

      {/* Arbitrator Voting Section */}
      {isArbitrator && isDisputeActive && (
        <div className="dispute-panel__voting">
          <h3 className="dispute-panel__section-title">Cast Your Vote</h3>
          <p className="dispute-panel__description">
            As the assigned arbitrator, you can approve the release or reject and initiate a refund.
          </p>

          <div className="dispute-panel__vote-buttons">
            <button
              onClick={() => handleVote(true)}
              disabled={votingAction !== null || loading}
              className="dispute-panel__button dispute-panel__button--approve"
              data-testid="vote-approve-button"
            >
              {votingAction === 'approve' ? 'Voting...' : '✓ Approve Release'}
            </button>

            <button
              onClick={() => handleVote(false)}
              disabled={votingAction !== null || loading}
              className="dispute-panel__button dispute-panel__button--reject"
              data-testid="vote-reject-button"
            >
              {votingAction === 'reject' ? 'Voting...' : '✗ Reject (Refund)'}
            </button>
          </div>
        </div>
      )}

      {/* Messages */}
      {error && (
        <div className="dispute-panel__message dispute-panel__message--error" data-testid="error-message">
          {error}
        </div>
      )}

      {successMessage && (
        <div className="dispute-panel__message dispute-panel__message--success" data-testid="success-message">
          {successMessage}
        </div>
      )}

      {/* Non-arbitrator message */}
      {!isArbitrator && isDisputeActive && (
        <div className="dispute-panel__message dispute-panel__message--info">
          Only the assigned arbitrator can vote on this dispute.
        </div>
      )}
    </div>
  );
};

export default DisputePanel;
