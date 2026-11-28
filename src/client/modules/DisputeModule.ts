import { BaseClientModule } from "./BaseModule.js";
import type {
  DisputeResult,
  ArbiterVote,
  DisputeStatus,
} from "../../types.js";

/**
 * Module dedicated to Dispute and Arbitration flows:
 * raising disputes, arbiter voting, resolving disputes, and evidence submission.
 */
export class DisputeModule extends BaseClientModule {
  /**
   * Raises a dispute on an invoice.
   */
  async raise(invoiceId: string): Promise<DisputeResult> {
    return this.client.raiseDispute(invoiceId);
  }

  /** Alias for `raise`. */
  async raiseDispute(invoiceId: string): Promise<DisputeResult> {
    return this.raise(invoiceId);
  }

  /**
   * Disputes an invoice (legacy entrypoint).
   */
  async dispute(invoiceId: string): Promise<DisputeResult> {
    return this.client.disputeInvoice(invoiceId);
  }

  /** Alias for `dispute`. */
  async disputeInvoice(invoiceId: string): Promise<DisputeResult> {
    return this.dispute(invoiceId);
  }

  /**
   * Submits an arbiter vote on an active dispute.
   */
  async submitVote(vote: ArbiterVote): Promise<DisputeResult> {
    return this.client.submitArbiterVote(vote);
  }

  /** Alias for `submitVote`. */
  async submitArbiterVote(vote: ArbiterVote): Promise<DisputeResult> {
    return this.submitVote(vote);
  }

  /**
   * Casts an arbiter vote and returns the transaction hash.
   */
  async vote(params: ArbiterVote): Promise<{ txHash: string }> {
    return this.client.voteDispute(params);
  }

  /** Alias for `vote`. */
  async voteDispute(params: ArbiterVote): Promise<{ txHash: string }> {
    return this.vote(params);
  }

  /**
   * Resolves a dispute with a final ruling. Forwards all arguments as given
   * to `client.resolveDispute` (supports both the positional
   * `(invoiceId, arbiter)` form and legacy object-based callers).
   */
  async resolve(...args: unknown[]): Promise<DisputeResult> {
    return (this.client.resolveDispute as (...a: unknown[]) => Promise<DisputeResult>)(...args);
  }

  /** Alias for `resolve`. */
  async resolveDispute(...args: unknown[]): Promise<DisputeResult> {
    return this.resolve(...args);
  }

  /**
   * Retrieves the current dispute status for an invoice.
   */
  async getStatus(invoiceId: string): Promise<DisputeStatus> {
    return this.client.getDisputeStatus(invoiceId);
  }

  /** Alias for `getStatus`. */
  async getDisputeStatus(invoiceId: string): Promise<DisputeStatus> {
    return this.getStatus(invoiceId);
  }

  /**
   * Adds evidence URI / hash to an active dispute.
   */
  async addEvidence(
    invoiceId: string,
    evidenceCid: string,
    fileName?: string
  ): Promise<{ txHash: string; cid: string }> {
    return this.client.addDisputeEvidence(invoiceId, evidenceCid, fileName);
  }

  /** Alias for `addEvidence`. */
  async addDisputeEvidence(
    invoiceId: string,
    evidenceCid: string,
    fileName?: string
  ): Promise<{ txHash: string; cid: string }> {
    return this.addEvidence(invoiceId, evidenceCid, fileName);
  }
}
