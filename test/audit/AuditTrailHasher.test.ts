import { describe, it, expect } from 'vitest';
import { AuditTrailHasher } from '../../src/audit/AuditTrailHasher';
import { AuditEvent } from '../../src/types/audit';

describe('AuditTrailHasher', () => {
  const createMockEvent = (id: number): AuditEvent => ({
    invoiceId: `inv-123`,
    actorId: `actor-${id}`,
    action: 'CREATE',
    payload: { amount: 100 * id },
    timestamp: 1670000000000 + id,
  });

  it('Appending 4 audit events and computing the root produces a deterministic 64-hex-character root hash', async () => {
    const hasher = new AuditTrailHasher();
    await hasher.append(createMockEvent(1));
    await hasher.append(createMockEvent(2));
    await hasher.append(createMockEvent(3));
    await hasher.append(createMockEvent(4));

    const root = await hasher.root();
    expect(typeof root).toBe('string');
    expect(root).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(root)).toBe(true);

    // Verify it's deterministic
    const hasher2 = new AuditTrailHasher();
    await hasher2.append(createMockEvent(1));
    await hasher2.append(createMockEvent(2));
    await hasher2.append(createMockEvent(3));
    await hasher2.append(createMockEvent(4));
    const root2 = await hasher2.root();
    expect(root).toEqual(root2);
  });

  it('Modifying any historical event payload field causes verify() to return { valid: false, mismatchAt: index }', async () => {
    const hasher = new AuditTrailHasher();
    await hasher.append(createMockEvent(1));
    await hasher.append(createMockEvent(2)); // index 1
    await hasher.append(createMockEvent(3));

    const originalRoot = await hasher.root();
    
    // Tamper with index 1
    const entries = hasher.getEntries();
    entries[1].event.payload.amount = 9999; 

    const result = await hasher.verify(originalRoot);
    expect(result.valid).toBe(false);
    expect(result.mismatchAt).toBe(1);
  });

  it('The Merkle root changes when events are appended', async () => {
    const hasher = new AuditTrailHasher();
    await hasher.append(createMockEvent(1));
    const root1 = await hasher.root();

    await hasher.append(createMockEvent(2));
    const root2 = await hasher.root();

    expect(root1).not.toEqual(root2);
  });

  it('verify() returns { valid: true } for an unmodified chain and accurately reports the chain length', async () => {
    const hasher = new AuditTrailHasher();
    await hasher.append(createMockEvent(1));
    await hasher.append(createMockEvent(2));
    await hasher.append(createMockEvent(3));

    const root = await hasher.root();
    const result = await hasher.verify(root);
    
    expect(result).toEqual({ valid: true, length: 3 });
  });

  it('An empty chain produces a well-defined root and verify() returns { valid: true, length: 0 }', async () => {
    const hasher = new AuditTrailHasher();
    const root = await hasher.root();
    
    expect(typeof root).toBe('string');
    expect(root).toHaveLength(64);

    const result = await hasher.verify(root);
    expect(result).toEqual({ valid: true, length: 0 });
  });
});
