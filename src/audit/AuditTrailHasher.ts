import { AuditEvent, AuditChainEntry, AuditTrailRoot } from '../types/audit';
import * as crypto from 'crypto';

// Use node crypto webcrypto subtle
const subtle = crypto.webcrypto.subtle;

export class AuditTrailHasher {
  private entries: AuditChainEntry[] = [];

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
   * Appends a new event to the audit trail
   */
  async append(event: AuditEvent): Promise<AuditChainEntry> {
    const index = this.entries.length;
    const prevHash = index > 0 ? this.entries[index - 1].hash : await AuditTrailHasher.sha256Hex('');
    
    // Hash stringified payload
    const dataString = JSON.stringify({ event, prevHash, index });
    const hash = await AuditTrailHasher.sha256Hex(dataString);
    
    const entry: AuditChainEntry = { event, hash, prevHash, index };
    this.entries.push(entry);
    return entry;
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
          nextLayer.push(await AuditTrailHasher.sha256Hex(currentLayer[i] + currentLayer[i + 1]));
        } else {
          // Odd number of nodes, pad with itself (left-pad/duplicate)
          nextLayer.push(await AuditTrailHasher.sha256Hex(currentLayer[i] + currentLayer[i]));
        }
      }
      currentLayer = nextLayer;
    }

    return currentLayer[0];
  }

  /**
   * Recomputes the root from stored entries and checks equality
   */
  async verify(expectedRoot: AuditTrailRoot): Promise<{ valid: boolean; mismatchAt?: number; length?: number }> {
    // Check integrity of the chain
    let prevHash = await AuditTrailHasher.sha256Hex('');
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      if (entry.index !== i) {
        return { valid: false, mismatchAt: i };
      }
      if (entry.prevHash !== prevHash) {
        return { valid: false, mismatchAt: i };
      }
      
      const dataString = JSON.stringify({ event: entry.event, prevHash: entry.prevHash, index: entry.index });
      const expectedHash = await AuditTrailHasher.sha256Hex(dataString);
      
      if (entry.hash !== expectedHash) {
        return { valid: false, mismatchAt: i };
      }
      
      prevHash = entry.hash;
    }

    // Check root
    const computedRoot = await this.root();
    if (computedRoot !== expectedRoot) {
      return { valid: false, mismatchAt: 0 };
    }

    return { valid: true, length: this.entries.length };
  }

  // Allow test access
  getEntries(): AuditChainEntry[] {
    return this.entries;
  }
}
