import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NonceManager } from '../src/nonceManager';
import { PaymentOrchestrator } from '../src/paymentOrchestrator';

describe('NonceManager concurrency', () => {
  let manager: NonceManager;
  const account = 'test-account';
  const initialNonce = 0;
  const incrementStep = 1;

  beforeEach(() => {
    manager = new NonceManager({ initialNonce, incrementStep });
  });

  describe('parallel nonce acquisition', () => {
    it('returns unique nonces for 100 concurrent acquisitions', async () => {
      const count = 100;
      const promises = Array.from({ length: count }, () =>
        manager.acquireNextNonce(account)
      );
      const nonces = await Promise.all(promises);

      const uniqueNonces = new Set(nonces);
      expect(uniqueNonces.size).toBe(count);
      expect(manager.getCurrentNonce(account)).toBe(
        initialNonce + count * incrementStep
      );
    });

    it('returns unique nonces across multiple accounts independently', async () => {
      const count = 50;
      const accountA = 'account-a';
      const accountB = 'account-b';

      const promisesA = Array.from({ length: count }, () =>
        manager.acquireNextNonce(accountA)
      );
      const promisesB = Array.from({ length: count }, () =>
        manager.acquireNextNonce(accountB)
      );

      const [noncesA, noncesB] = await Promise.all([
        Promise.all(promisesA),
        Promise.all(promisesB),
      ]);

      expect(new Set(noncesA).size).toBe(count);
      expect(new Set(noncesB).size).toBe(count);
      expect(manager.getCurrentNonce(accountA)).toBe(
        initialNonce + count * incrementStep
      );
      expect(manager.getCurrentNonce(accountB)).toBe(
        initialNonce + count * incrementStep
      );
    });
  });

  describe('state consistency', () => {
    it('clears in-flight nonces after commit', async () => {
      const nonce = await manager.acquireNextNonce(account);
      expect(manager.getInFlightNonces(account)).toContain(nonce);

      manager.commitNonce(account, nonce);

      expect(manager.getInFlightNonces(account)).toHaveLength(0);
      expect(manager.getCurrentNonce(account)).toBe(initialNonce + incrementStep);
    });

    it('clears in-flight nonces after rollback', async () => {
      const nonce = await manager.acquireNextNonce(account);
      expect(manager.getInFlightNonces(account)).toContain(nonce);

      manager.rollbackNonce(account, nonce);

      expect(manager.getInFlightNonces(account)).toHaveLength(0);
      expect(manager.getCurrentNonce(account)).toBe(initialNonce + incrementStep);
    });

    it('tracks multiple in-flight nonces and clears them all', async () => {
      const count = 10;
      const nonces = await Promise.all(
        Array.from({ length: count }, () => manager.acquireNextNonce(account))
      );

      expect(manager.getInFlightNonces(account)).toHaveLength(count);

      nonces.forEach((nonce) => manager.commitNonce(account, nonce));

      expect(manager.getInFlightNonces(account)).toHaveLength(0);
      expect(manager.getCurrentNonce(account)).toBe(
        initialNonce + count * incrementStep
      );
    });
  });

  describe('error scenarios', () => {
    it('does not corrupt subsequent acquisitions after rollback', async () => {
      const first = await manager.acquireNextNonce(account);
      manager.rollbackNonce(account, first);

      const second = await manager.acquireNextNonce(account);
      expect(second).not.toBe(first);
      expect(second).toBe(initialNonce + incrementStep);

      manager.commitNonce(account, second);
      expect(manager.getCurrentNonce(account)).toBe(
        initialNonce + 2 * incrementStep
      );
    });

    it('handles rollback of unknown nonce gracefully', () => {
      expect(() => manager.rollbackNonce(account, 9999)).not.toThrow();
      expect(manager.getInFlightNonces(account)).toHaveLength(0);
    });

    it('handles commit of unknown nonce gracefully', () => {
      expect(() => manager.commitNonce(account, 9999)).not.toThrow();
      expect(manager.getInFlightNonces(account)).toHaveLength(0);
    });

    it('maintains consistency when mixing commits and rollbacks', async () => {
      const count = 20;
      const nonces = await Promise.all(
        Array.from({ length: count }, () => manager.acquireNextNonce(account))
      );

      nonces.forEach((nonce, index) => {
        if (index % 2 === 0) {
          manager.commitNonce(account, nonce);
        } else {
          manager.rollbackNonce(account, nonce);
        }
      });

      expect(manager.getInFlightNonces(account)).toHaveLength(0);
      expect(manager.getCurrentNonce(account)).toBe(
        initialNonce + count * incrementStep
      );
    });
  });

  describe('race conditions', () => {
    it('produces no duplicates across 10 rounds of 50 concurrent acquisitions', async () => {
      const rounds = 10;
      const perRound = 50;
      const allNonces: number[] = [];

      for (let round = 0; round < rounds; round++) {
        const nonces = await Promise.all(
          Array.from({ length: perRound }, () =>
            manager.acquireNextNonce(account)
          )
        );
        allNonces.push(...nonces);
      }

      const uniqueNonces = new Set(allNonces);
      expect(uniqueNonces.size).toBe(rounds * perRound);
      expect(manager.getCurrentNonce(account)).toBe(
        initialNonce + rounds * perRound * incrementStep
      );
    });

    it('has no lost updates under concurrent acquire and commit', async () => {
      const count = 50;
      const nonces = await Promise.all(
        Array.from({ length: count }, () => manager.acquireNextNonce(account))
      );

      await Promise.all(
        nonces.map((nonce) =>
          Promise.resolve().then(() => manager.commitNonce(account, nonce))
        )
      );

      expect(manager.getInFlightNonces(account)).toHaveLength(0);
      expect(manager.getCurrentNonce(account)).toBe(
        initialNonce + count * incrementStep
      );
    });
  });
});

describe('PaymentOrchestrator concurrency', () => {
  let orchestrator: PaymentOrchestrator;

  beforeEach(() => {
    orchestrator = new PaymentOrchestrator();
  });

  const createPayment = (overrides: Record<string, unknown> = {}) => ({
    amount: 100,
    currency: 'USD',
    recipient: 'recipient-1',
    ...overrides,
  });

  describe('queueing and processing', () => {
    it('assigns unique ids to queued payments', async () => {
      const count = 20;
      const payments = Array.from({ length: count }, () =>
        createPayment()
      );

      const ids = await Promise.all(
        payments.map((payment) => orchestrator.queuePayment(payment))
      );

      expect(new Set(ids).size).toBe(count);
    });

    it('transitions statuses from queued to completed', async () => {
      const id = await orchestrator.queuePayment(createPayment());
      expect(orchestrator.getStatus(id)).toBe('queued');

      await orchestrator.processPayment(id);
      expect(orchestrator.getStatus(id)).toBe('completed');
    });

    it('transitions statuses from queued to failed on error', async () => {
      const id = await orchestrator.queuePayment(
        createPayment({ amount: -1 })
      );
      expect(orchestrator.getStatus(id)).toBe('queued');

      await orchestrator.processPayment(id);
      expect(orchestrator.getStatus(id)).toBe('failed');
    });

    it('processes multiple payments concurrently with correct statuses', async () => {
      const count = 10;
      const ids = await Promise.all(
        Array.from({ length: count }, () =>
          orchestrator.queuePayment(createPayment())
        )
      );

      await Promise.all(ids.map((id) => orchestrator.processPayment(id)));

      ids.forEach((id) => {
        expect(orchestrator.getStatus(id)).toBe('completed');
      });
    });
  });

  describe('error isolation', () => {
    it('does not corrupt other payments when one fails', async () => {
      const goodIds = await Promise.all(
        Array.from({ length: 5 }, () =>
          orchestrator.queuePayment(createPayment())
        )
      );
      const badId = await orchestrator.queuePayment(
        createPayment({ amount: -1 })
      );

      await Promise.all([
        ...goodIds.map((id) => orchestrator.processPayment(id)),
        orchestrator.processPayment(badId),
      ]);

      goodIds.forEach((id) => {
        expect(orchestrator.getStatus(id)).toBe('completed');
      });
      expect(orchestrator.getStatus(badId)).toBe('failed');
    });

    it('handles processing an unknown payment id gracefully', async () => {
      await expect(
        orchestrator.processPayment('unknown-id')
      ).rejects.toThrow();
    });
  });

  describe('race conditions', () => {
    it('maintains unique ids and consistent statuses under stress', async () => {
      const rounds = 5;
      const perRound = 20;
      const allIds: string[] = [];

      for (let round = 0; round < rounds; round++) {
        const ids = await Promise.all(
          Array.from({ length: perRound }, () =>
            orchestrator.queuePayment(createPayment())
          )
        );
        allIds.push(...ids);
      }

      expect(new Set(allIds).size).toBe(rounds * perRound);

      await Promise.all(
        allIds.map((id) => orchestrator.processPayment(id))
      );

      allIds.forEach((id) => {
        expect(orchestrator.getStatus(id)).toBe('completed');
      });
    });

    it('does not double-process a payment', async () => {
      const id = await orchestrator.queuePayment(createPayment());

      const results = await Promise.allSettled([
        orchestrator.processPayment(id),
        orchestrator.processPayment(id),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      expect(orchestrator.getStatus(id)).toBe('completed');
    });
  });
});