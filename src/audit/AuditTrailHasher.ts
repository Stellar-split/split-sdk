import {
  AuditEvent,
  AuditChainEntry,
  AuditTrailRoot,
  CrossTenantAuditRecord,
  CrossTenantAuditQuery,
  CrossTenantAuditListener,
  CrossTenantAuditEvent,
  MerkleProof,
} from '../types/audit';
import * as crypto from 'crypto';

// Use node crypto webcrypto subtle
const subtle = crypto.webcrypto.subtle;

export type AuditTrailListener = (entry: AuditChainEntry) => void;

export class AuditTrailHasher {
  private entries: AuditChainEntry[] = [];
  private listeners: Set<AuditTrailListener> = new Set();
  private crossTenantRecords: CrossTenantAuditRecord[] = [];
  private crossTenantListeners: Set<CrossTenantAuditListener> = new Set();

  constructor(entries: AuditChainEntry[] = []) {
    this.entries = [...entries];
  }

  /**
   * Helper to hash an object into a 64-character hex string using SHA-256
   */
  private static async sha256Hex(data: string): Promise<string> {
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    const hashBuffer = await subtle.digest('SHA-256', dataBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Subscribes to audit trail events. Returns an unsubscribe function.
   */
  onAppend(listener: AuditTrailListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Removes a previously registered audit trail listener.
   */
  offAppend(listener: AuditTrailListener): void {
    this.listeners.delete(listener);
  }

  private emitAppend(entry: AuditChainEntry): void {
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // Listener errors must not break the audit chain.
      }
    }
  }

  /**
   * Appends a new event to the audit trail
   */
  async append(event: AuditEvent): Promise<AuditChainEntry> {
    const index = this.entries.length;
    const prevHash = index > 0 ? this.entries[index - 1]!.hash : await AuditTrailHasher.sha256Hex('');
    
    // Hash stringified payload
    const dataString = JSON.stringify({ event, prevHash, index });
    const hash = await AuditTrailHasher.sha256Hex(dataString);
    
    const entry: AuditChainEntry = { event, hash, prevHash, index };
    this.entries.push(entry);
    this.emitAppend(entry);
    return entry;
  }

  /**
   * Records an invoice audit entry scoped to a tenant, enabling cross-tenant auditing.
   * Emits an 'invoice.audited' lifecycle event.
   */
  async auditInvoice(tenantId: string, invoiceId: string, event: AuditEvent): Promise<CrossTenantAuditRecord> {
    const entry = await this.append(event);
    const record: CrossTenantAuditRecord = {
      tenantId,
      invoiceId,
      event,
      entry,
      recordedAt: Date.now(),
    };
    this.crossTenantRecords.push(record);
    this.emit({
      type: 'invoice.audited',
      tenantId,
      invoiceId,
      entry,
      timestamp: record.recordedAt,
    });
    return record;
  }

  /**
   * Records a cross-tenant access attempt against an invoice and emits a
   * 'invoice.cross-tenant-access' event so consumers can react to it.
   */
  async recordCrossTenantAccess(
    accessingTenantId: string,
    invoiceTenantId: string,
    invoiceId: string,
    event: AuditEvent,
  ): Promise<CrossTenantAuditRecord> {
    const entry = await this.append(event);
    const record: CrossTenantAuditRecord = {
      tenantId: accessingTenantId,
      invoiceId,
      event,
      entry,
      recordedAt: Date.now(),
    };
    this.crossTenantRecords.push(record);
    this.emit({
      type: 'invoice.cross-tenant-access',
      tenantId: accessingTenantId,
      invoiceId,
      entry,
      timestamp: record.recordedAt,
    });
    return record;
  }

  /**
   * Queries recorded cross-tenant audit entries, optionally filtered by tenant
   * and/or invoice. Returns a defensive copy to preserve isolation.
   */
  queryCrossTenantAudits(query: CrossTenantAuditQuery = {}): CrossTenantAuditRecord[] {
    return this.crossTenantRecords
      .filter(r => (query.tenantId === undefined || r.tenantId === query.tenantId))
      .filter(r => (query.invoiceId === undefined || r.invoiceId === query.invoiceId))
      .map(r => ({ ...r }));
  }

  /**
   * Verifies that a tenant's recorded audit entries are intact and match the
   * expected chain root, enforcing cross-tenant isolation.
   */
  async verifyTenantAudit(
    tenantId: string,
    expectedRoot: AuditTrailRoot,
  ): Promise<{ valid: boolean; mismatchAt?: number; length?: number }> {
    const tenantEntries = this.crossTenantRecords
      .filter(r => r.tenantId === tenantId)
      .map(r => r.entry);
    const scoped = new AuditTrailHasher(tenantEntries);
    return scoped.verify(expectedRoot);
  }

  /**
   * Registers a listener for cross-tenant audit lifecycle events.
   */
  on(listener: CrossTenantAuditListener): () => void {
    this.crossTenantListeners.add(listener);
    return () => this.crossTenantListeners.delete(listener);
  }

  /**
   * Removes a previously registered listener.
   */
  off(listener: CrossTenantAuditListener): void {
    this.crossTenantListeners.delete(listener);
  }

  private emit(event: CrossTenantAuditEvent): void {
    for (const listener of this.crossTenantListeners) {
      listener(event);
    }
  }

  /**
   * Computes a Merkle root over all current chain entry hashes using pairwise SHA-256 combining
   */
  async root(): Promise<AuditTrailRoot> {
    if (this.entries.length === 0) {
      return AuditTrailHasher.sha256Hex('');
    }

    let currentLayer = this.entries.map(e => e.hash);

    while (currentLayer.length > 1) {
      const nextLayer: string[] = [];
      for (let i = 0; i < currentLayer.length; i += 2) {
        if (i + 1 < currentLayer.length) {
          nextLayer.push(await AuditTrailHasher.sha256Hex(currentLayer[i]! + currentLayer[i + 1]!));
        } else {
          // Odd number of nodes, pad with itself (left-pad/duplicate)
          nextLayer.push(await AuditTrailHasher.sha256Hex(currentLayer[i]! + currentLayer[i]!));
        }
      }
      currentLayer = nextLayer;
    }

    return currentLayer[0]!;
  }

  /**
   * Generates a Merkle inclusion proof for the entry at the given index
   */
  async proof(index: number): Promise<MerkleProof> {
    if (index < 0 || index >= this.entries.length) {
      throw new Error(`Index ${index} out of bounds for ${this.entries.length} entries`);
    }

    const leaf = this.entries[index]!.hash;
    const siblings: MerkleProof['siblings'] = [];
    let currentLayer = this.entries.map(e => e.hash);
    let currentIndex = index;

    while (currentLayer.length > 1) {
      const isRightNode = currentIndex % 2 === 1;
      const siblingIndex = isRightNode ? currentIndex - 1 : currentIndex + 1;
      const siblingHash = siblingIndex < currentLayer.length
        ? currentLayer[siblingIndex]!
        : currentLayer[currentIndex]!;

      siblings.push({
        hash: siblingHash,
        position: isRightNode ? 'left' : 'right',
      });

      const nextLayer: string[] = [];
      for (let i = 0; i < currentLayer.length; i += 2) {
        if (i + 1 < currentLayer.length) {
          nextLayer.push(await AuditTrailHasher.sha256Hex(currentLayer[i]! + currentLayer[i + 1]!));
        } else {
          nextLayer.push(await AuditTrailHasher.sha256Hex(currentLayer[i]! + currentLayer[i]!));
        }
      }
      currentLayer = nextLayer;
      currentIndex = Math.floor(currentIndex / 2);
    }

    return { leaf, index, siblings, root: currentLayer[0]! };
  }

  /**
   * Verifies a Merkle inclusion proof against an expected root
   */
  static async verifyProof(proof: MerkleProof, expectedRoot: AuditTrailRoot): Promise<boolean> {
    let computed = proof.leaf;
    for (const sibling of proof.siblings) {
      if (sibling.position === 'left') {
        computed = await AuditTrailHasher.sha256Hex(sibling.hash + computed);
      } else {
        computed = await AuditTrailHasher.sha256Hex(computed + sibling.hash);
      }
    }
    return computed === expectedRoot && proof.root === expectedRoot;
  }

  /**
   * Recomputes the root from stored entries and checks equality
   */
  async verify(expectedRoot: AuditTrailRoot): Promise<{ valid: boolean; mismatchAt?: number; length?: number }> {
    this.emit({ type: 'validation:start', expectedRoot, length: this.entries.length });

    // Check integrity of the chain
    let prevHash = await AuditTrailHasher.sha256Hex('');
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      if (entry.index !== i) {
        this.emit({ type: 'validation:failure', reason: 'index-mismatch', mismatchAt: i });
        return { valid: false, mismatchAt: i };
      }
      if (entry.prevHash !== prevHash) {
        this.emit({ type: 'validation:failure', reason: 'prev-hash-mismatch', mismatchAt: i });
        return { valid: false, mismatchAt: i };
      }
      
      const dataString = JSON.stringify({ event: entry.event, prevHash: entry.prevHash, index: entry.index });
      const expectedHash = await AuditTrailHasher.sha256Hex(dataString);
      
      if (entry.hash !== expectedHash) {
        this.emit({ type: 'validation:failure', reason: 'entry-hash-mismatch', mismatchAt: i });
        return { valid: false, mismatchAt: i };
      }
      
      prevHash = entry.hash;
    }

    // Check root
    const computedRoot = await this.root();
    if (computedRoot !== expectedRoot) {
      this.emit({ type: 'validation:failure', reason: 'root-mismatch', mismatchAt: 0 });
      return { valid: false, mismatchAt: 0 };
    }

    this.emit({ type: 'validation:success', root: computedRoot, length: this.entries.length });
    return { valid: true, length: this.entries.length };
  }

  // Allow test access
  getEntries(): AuditChainEntry[] {
    return this.entries;
  }
}
