import { EventEmitter } from 'node:events';
import type { TransactionEvent, TransactionEventType } from './events/types.js';

export interface TransactionRequest {
  id: string;
  from: string;
  to: string;
  amount: string;
  asset?: string;
  memo?: string;
  network?: string;
}

export interface SimulationResult {
  success: boolean;
  fee?: string;
  error?: string;
}

export interface SignedTransaction {
  id: string;
  signedXdr: string;
  signer: string;
}

export interface SubmissionResult {
  success: boolean;
  hash?: string;
  error?: string;
}

export interface ConfirmationResult {
  success: boolean;
  ledger?: number;
  error?: string;
}

export class TransactionSigner {
  private readonly emitter: EventEmitter;

  constructor(emitter: EventEmitter = new EventEmitter()) {
    this.emitter = emitter;
  }

  private emit(
    type: TransactionEventType,
    transactionId: string,
    details: Record<string, unknown> = {},
    error?: unknown,
  ): void {
    const event: TransactionEvent = {
      type,
      transactionId,
      timestamp: new Date().toISOString(),
      details,
    };

    if (error !== undefined) {
      event.error = {
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : undefined,
      };
    }

    this.emitter.emit(type, event);
  }

  async createTransaction(request: TransactionRequest): Promise<TransactionRequest> {
    try {
      this.emit('transaction.created', request.id, {
        from: request.from,
        to: request.to,
        amount: request.amount,
        asset: request.asset,
        network: request.network,
      });
      return request;
    } catch (error) {
      this.emit('transaction.error', request.id, { step: 'created' }, error);
      throw error;
    }
  }

  async simulate(transaction: TransactionRequest): Promise<SimulationResult> {
    try {
      const result: SimulationResult = { success: true };
      this.emit('transaction.simulated', transaction.id, {
        success: result.success,
        fee: result.fee,
      });
      return result;
    } catch (error) {
      this.emit('transaction.error', transaction.id, { step: 'simulated' }, error);
      throw error;
    }
  }

  async sign(transaction: TransactionRequest, signer: string): Promise<SignedTransaction> {
    try {
      const signed: SignedTransaction = {
        id: transaction.id,
        signedXdr: '',
        signer,
      };
      this.emit('transaction.signed', transaction.id, { signer });
      return signed;
    } catch (error) {
      this.emit('transaction.error', transaction.id, { step: 'signed' }, error);
      throw error;
    }
  }

  async submit(signed: SignedTransaction): Promise<SubmissionResult> {
    try {
      const result: SubmissionResult = { success: true };
      this.emit('transaction.submitted', signed.id, {
        success: result.success,
        hash: result.hash,
      });
      return result;
    } catch (error) {
      this.emit('transaction.error', signed.id, { step: 'submitted' }, error);
      throw error;
    }
  }

  async confirm(transactionId: string, result: ConfirmationResult): Promise<ConfirmationResult> {
    try {
      this.emit('transaction.confirmed', transactionId, {
        success: result.success,
        ledger: result.ledger,
      });
      return result;
    } catch (error) {
      this.emit('transaction.error', transactionId, { step: 'confirmed' }, error);
      throw error;
    }
  }
}
