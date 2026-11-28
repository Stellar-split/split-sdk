import { EventEmitter } from 'node:events';
import type { TransactionEvent, TransactionEventType } from './events/types.js';

export interface TransactionStepResult {
  success: boolean;
  error?: string;
  details?: Record<string, unknown>;
}

export interface TransactionBuilderOptions {
  emitter?: EventEmitter;
}

export class TransactionBuilder {
  private emitter?: EventEmitter;
  private transactionId: string;
  private step: TransactionEventType = 'created';

  constructor(options: TransactionBuilderOptions = {}) {
    this.emitter = options.emitter;
    this.transactionId = this.generateTransactionId();
  }

  private generateTransactionId(): string {
    return `tx_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  private emit(
    type: TransactionEventType,
    result?: TransactionStepResult,
    details?: Record<string, unknown>,
  ): void {
    this.step = type;
    if (!this.emitter) {
      return;
    }
    const event: TransactionEvent = {
      type,
      transactionId: this.transactionId,
      timestamp: Date.now(),
      success: result ? result.success : true,
      error: result && result.error ? result.error : undefined,
      details: { ...(details || {}), ...(result && result.details ? result.details : {}) },
    };
    this.emitter.emit('transaction', event);
  }

  getTransactionId(): string {
    return this.transactionId;
  }

  getCurrentStep(): TransactionEventType {
    return this.step;
  }

  create(details?: Record<string, unknown>): this {
    this.emit('created', { success: true }, details);
    return this;
  }

  simulate(result?: TransactionStepResult, details?: Record<string, unknown>): this {
    this.emit('simulated', result || { success: true }, details);
    return this;
  }

  sign(result?: TransactionStepResult, details?: Record<string, unknown>): this {
    this.emit('signed', result || { success: true }, details);
    return this;
  }

  submit(result?: TransactionStepResult, details?: Record<string, unknown>): this {
    this.emit('submitted', result || { success: true }, details);
    return this;
  }

  confirm(result?: TransactionStepResult, details?: Record<string, unknown>): this {
    this.emit('confirmed', result || { success: true }, details);
    return this;
  }

  fail(error: string, details?: Record<string, unknown>): this {
    this.emit('error', { success: false, error }, details);
    return this;
  }
}
