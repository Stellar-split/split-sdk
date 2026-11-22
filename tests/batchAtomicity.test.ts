import { describe, it, expect, vi } from 'vitest';
import {
  validateBatchOperations,
  BatchOperationBuilder,
  ValidationError,
} from '../src/batchOperations';
import { TransactionRollbackSimulator } from '../src/autoRecovery';
import { verifyBatchPayments } from '../src/batchVerifier';

describe('Batch operation atomicity (#1239)', () => {
  describe('all-or-nothing', () => {
    it('throws ValidationError before execution when an operation has a bad destination', () => {
      const operations = [
        { destination: 'valid-destination', amount: 100, token: 'TOKEN' },
        { destination: '', amount: 50, token: 'TOKEN' },
      ];

      expect(() => validateBatchOperations(operations)).toThrow(ValidationError);
    });

    it('throws ValidationError before execution when an operation has a zero amount', () => {
      const operations = [
        { destination: 'valid-destination', amount: 100, token: 'TOKEN' },
        { destination: 'another-destination', amount: 0, token: 'TOKEN' },
      ];

      expect(() => validateBatchOperations(operations)).toThrow(ValidationError);
    });

    it('does not throw for a fully valid batch', () => {
      const operations = [
        { destination: 'valid-destination', amount: 100, token: 'TOKEN' },
        { destination: 'another-destination', amount: 50, token: 'TOKEN' },
      ];

      expect(() => validateBatchOperations(operations)).not.toThrow();
    });
  });

  describe('partial failures', () => {
    it('rejects the whole batch when one operation is invalid', () => {
      const operations = [
        { destination: 'valid-destination', amount: 100, token: 'TOKEN' },
        { destination: 'another-destination', amount: 50, token: 'TOKEN' },
        { destination: 'third-destination', amount: -10, token: 'TOKEN' },
      ];

      expect(() => validateBatchOperations(operations)).toThrow(ValidationError);
    });

    it('rejects the whole batch when one operation is missing a token', () => {
      const operations = [
        { destination: 'valid-destination', amount: 100, token: 'TOKEN' },
        { destination: 'another-destination', amount: 50, token: '' },
      ];

      expect(() => validateBatchOperations(operations)).toThrow(ValidationError);
    });
  });

  describe('state rollback', () => {
    it('rolls back after exhausting maxAttempts and emits lifecycle events in order', async () => {
      const events: string[] = [];
      const simulator = new TransactionRollbackSimulator({
        maxAttempts: 3,
        shouldFail: () => true,
        onStart: () => events.push('start'),
        onSuccess: () => events.push('success'),
        onFailure: () => events.push('failure'),
      });

      const result = await simulator.run(async () => {
        throw new Error('simulated failure');
      });

      expect(result.rolledBack).toBe(true);
      expect(result.success).toBe(false);
      expect(events.filter((e) => e === 'start')).toHaveLength(3);
      expect(events.filter((e) => e === 'failure')).toHaveLength(3);
      expect(events).not.toContain('success');
      expect(events[0]).toBe('start');
      expect(events[events.length - 1]).toBe('failure');
    });
  });

  describe('recovery', () => {
    it('succeeds on the second attempt when failing once then succeeding', async () => {
      let attempts = 0;
      const simulator = new TransactionRollbackSimulator({
        maxAttempts: 3,
        shouldFail: () => {
          attempts += 1;
          return attempts === 1;
        },
      });

      const result = await simulator.run(async () => 'ok');

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(2);
      expect(result.rolledBack).toBe(false);
    });
  });

  describe('consistency', () => {
    it('clear() resets builder state', () => {
      const builder = new BatchOperationBuilder();
      builder.add({ destination: 'dest-1', amount: 100, token: 'TOKEN' });
      builder.add({ destination: 'dest-2', amount: 50, token: 'TOKEN' });

      expect(builder.getOperations()).toHaveLength(2);

      builder.clear();

      expect(builder.getOperations()).toHaveLength(0);
    });

    it('getOperations() returns a copy that does not affect the builder', () => {
      const builder = new BatchOperationBuilder();
      builder.add({ destination: 'dest-1', amount: 100, token: 'TOKEN' });

      const ops = builder.getOperations();
      ops.push({ destination: 'injected', amount: 1, token: 'TOKEN' });
      ops.length = 0;

      expect(builder.getOperations()).toHaveLength(1);
      expect(builder.getOperations()[0].destination).toBe('dest-1');
    });
  });
});

describe('verifyBatchPayments (#1239)', () => {
  it('returns valid=false with descriptive errors for a non-Pending invoice', () => {
    const payments = [
      {
        invoice: { id: 'inv-1', status: 'Paid', token: 'TOKEN' },
        token: 'TOKEN',
      },
    ];

    const result = verifyBatchPayments(payments);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.join(' ')).toMatch(/pending/i);
  });

  it('returns valid=false with descriptive errors for a mismatched token', () => {
    const payments = [
      {
        invoice: { id: 'inv-1', status: 'Pending', token: 'TOKEN-A' },
        token: 'TOKEN-B',
      },
    ];

    const result = verifyBatchPayments(payments);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.join(' ')).toMatch(/token/i);
  });

  it('returns valid=true for a fully valid batch', () => {
    const payments = [
      {
        invoice: { id: 'inv-1', status: 'Pending', token: 'TOKEN' },
        token: 'TOKEN',
      },
      {
        invoice: { id: 'inv-2', status: 'Pending', token: 'TOKEN-2' },
        token: 'TOKEN-2',
      },
    ];

    const result = verifyBatchPayments(payments);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});