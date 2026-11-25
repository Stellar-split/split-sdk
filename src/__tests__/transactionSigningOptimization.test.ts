import { describe, it, expect, beforeEach } from 'vitest';
import {
  SigningKeyManager,
  OptimizedTransactionSigner,
  KeyNotFoundError,
  KeyStoreFullError,
} from '../transactionSigningOptimization.js';
import type { KeyRecord, BatchSignRequest } from '../transactionSigningOptimization.js';

function makeKey(id: string): KeyRecord {
  return {
    id,
    publicKey: `pubkey_${id}`,
    async sign(txHash: Buffer): Promise<Buffer> {
      // Simulate ed25519: XOR first byte as a simple deterministic "signature"
      const sig = Buffer.alloc(64, 0);
      txHash.copy(sig, 0, 0, Math.min(32, txHash.length));
      return sig;
    },
  };
}

function makeTxHash(byte = 0xab): Buffer {
  return Buffer.alloc(32, byte);
}

// ─── Test 1: SigningKeyManager — key CRUD ────────────────────────────────────
describe('SigningKeyManager', () => {
  it('adds and retrieves keys by id', () => {
    const mgr = new SigningKeyManager();
    const key = makeKey('k1');
    mgr.addKey(key);
    expect(mgr.hasKey('k1')).toBe(true);
    expect(mgr.getKey('k1')).toBe(key);
    expect(mgr.size).toBe(1);
  });

  it('removes keys and respects maxKeys', () => {
    const mgr = new SigningKeyManager({ maxKeys: 2 });
    mgr.addKey(makeKey('a'));
    mgr.addKey(makeKey('b'));
    expect(() => mgr.addKey(makeKey('c'))).toThrow(KeyStoreFullError);
    expect(mgr.removeKey('a')).toBe(true);
    // Now there is room
    mgr.addKey(makeKey('c'));
    expect(mgr.listKeyIds()).toContain('c');
  });
});

// ─── Test 2: Single-transaction signing ──────────────────────────────────────
describe('OptimizedTransactionSigner — single sign', () => {
  let signer: OptimizedTransactionSigner;

  beforeEach(() => {
    signer = new OptimizedTransactionSigner();
    signer.keyManager_.addKey(makeKey('k1'));
  });

  it('signs a transaction and returns a 64-byte Buffer', async () => {
    const sig = await signer.sign('tx1', makeTxHash(), 'k1');
    expect(Buffer.isBuffer(sig)).toBe(true);
    expect(sig.length).toBe(64);
  });

  it('throws KeyNotFoundError for unknown key', async () => {
    await expect(signer.sign('tx1', makeTxHash(), 'missing')).rejects.toThrow(KeyNotFoundError);
  });
});

// ─── Test 3: Batch signing ───────────────────────────────────────────────────
describe('OptimizedTransactionSigner — batch sign', () => {
  let signer: OptimizedTransactionSigner;

  beforeEach(() => {
    signer = new OptimizedTransactionSigner({ batchConcurrency: 4 });
    signer.keyManager_.addKey(makeKey('k1'));
    signer.keyManager_.addKey(makeKey('k2'));
  });

  it('signs a batch and returns one result per request', async () => {
    const requests: BatchSignRequest[] = [
      { txId: 'tx1', txHash: makeTxHash(0x01), keyId: 'k1' },
      { txId: 'tx2', txHash: makeTxHash(0x02), keyId: 'k2' },
      { txId: 'tx3', txHash: makeTxHash(0x03), keyId: 'k1' },
    ];
    const results = await signer.signBatch(requests);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.every((r) => r.signature !== null && (r.signature as Buffer).length === 64)).toBe(true);
  });

  it('marks missing-key requests as failed without aborting the batch', async () => {
    const requests: BatchSignRequest[] = [
      { txId: 'tx1', txHash: makeTxHash(), keyId: 'k1' },
      { txId: 'tx2', txHash: makeTxHash(), keyId: 'no_such_key' },
    ];
    const results = await signer.signBatch(requests);
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    expect(results[1].error).toMatch(/not found/i);
  });

  it('returns empty array for empty batch', async () => {
    const results = await signer.signBatch([]);
    expect(results).toEqual([]);
  });
});

// ─── Test 4: Metrics ─────────────────────────────────────────────────────────
describe('OptimizedTransactionSigner — metrics', () => {
  it('tracks totalSigned, totalFailed and totalBatches', async () => {
    const signer = new OptimizedTransactionSigner();
    signer.keyManager_.addKey(makeKey('k1'));

    await signer.sign('tx1', makeTxHash(), 'k1');
    await signer.signBatch([
      { txId: 'tx2', txHash: makeTxHash(), keyId: 'k1' },
      { txId: 'tx3', txHash: makeTxHash(), keyId: 'missing' },
    ]);

    const m = signer.getMetrics();
    expect(m.totalSigned).toBe(2);   // tx1 + tx2
    expect(m.totalFailed).toBe(1);   // tx3 key missing
    expect(m.totalBatches).toBe(1);
  });

  it('resets metrics', async () => {
    const signer = new OptimizedTransactionSigner();
    signer.keyManager_.addKey(makeKey('k1'));
    await signer.sign('tx1', makeTxHash(), 'k1');
    signer.resetMetrics();
    const m = signer.getMetrics();
    expect(m.totalSigned).toBe(0);
    expect(m.totalFailed).toBe(0);
    expect(m.totalBatches).toBe(0);
    expect(m.avgDurationMs).toBe(0);
  });
});

// ─── Test 5: Memory footprint — key clear ────────────────────────────────────
describe('SigningKeyManager — memory management', () => {
  it('clears all keys reducing size to zero', () => {
    const mgr = new SigningKeyManager();
    mgr.addKey(makeKey('a'));
    mgr.addKey(makeKey('b'));
    mgr.clear();
    expect(mgr.size).toBe(0);
    expect(mgr.listKeyIds()).toEqual([]);
  });
});

// ─── Test 6: Concurrency chunking ────────────────────────────────────────────
describe('OptimizedTransactionSigner — concurrency', () => {
  it('processes batches larger than batchConcurrency correctly', async () => {
    const signer = new OptimizedTransactionSigner({ batchConcurrency: 2 });
    for (let i = 0; i < 5; i++) signer.keyManager_.addKey(makeKey(`k${i}`));

    const requests: BatchSignRequest[] = Array.from({ length: 10 }, (_, i) => ({
      txId: `tx${i}`,
      txHash: makeTxHash(i),
      keyId: `k${i % 5}`,
    }));

    const results = await signer.signBatch(requests);
    expect(results).toHaveLength(10);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});
