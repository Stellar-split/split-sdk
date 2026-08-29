/**
 * Access Control List (ACL) manager for application-level authorization.
 *
 * Manages off-chain access grants for resources like invoices.
 */

export interface AsyncAclStore {
  grant(resourceId: string, address: string): Promise<void>;
  revoke(resourceId: string, address: string): Promise<void>;
  check(resourceId: string, address: string): Promise<boolean>;
}

export interface AclManagerOptions {
  cacheTtlMs?: number;
}

interface CacheEntry {
  value: boolean;
  expiresAt: number;
}

class InMemoryAclStore implements AsyncAclStore {
  private grants = new Map<string, Set<string>>();

  async grant(resourceId: string, address: string): Promise<void> {
    if (!this.grants.has(resourceId)) {
      this.grants.set(resourceId, new Set());
    }
    this.grants.get(resourceId)!.add(address);
  }

  async revoke(resourceId: string, address: string): Promise<void> {
    this.grants.get(resourceId)?.delete(address);
  }

  async check(resourceId: string, address: string): Promise<boolean> {
    return this.grants.get(resourceId)?.has(address) ?? false;
  }
}

/**
 * Manager for access control lists.
 *
 * Supports custom storage backends for persistence.
 */
export class AclManager {
  private readonly store: AsyncAclStore;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(store?: AsyncAclStore, options: AclManagerOptions = {}) {
    this.store = store ?? new InMemoryAclStore();
    this.cacheTtlMs = options.cacheTtlMs ?? 60_000;
  }

  /**
   * Grant access to a resource for an address.
   *
   * @param resourceId - Resource identifier
   * @param address - Stellar address to grant access
   */
  async grant(resourceId: string, address: string): Promise<void> {
    await this.store.grant(resourceId, address);
    this.invalidateCache(address);
  }

  /**
   * Revoke access to a resource for an address.
   *
   * @param resourceId - Resource identifier
   * @param address - Stellar address to revoke access
   */
  async revoke(resourceId: string, address: string): Promise<void> {
    await this.store.revoke(resourceId, address);
    this.invalidateCache(address);
  }

  /**
   * Check if an address has access to a resource.
   *
   * @param resourceId - Resource identifier
   * @param address - Stellar address to check
   * @returns True if access is granted
   */
  async check(resourceId: string, address: string): Promise<boolean> {
    const key = this.cacheKey(resourceId, address);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const allowed = await this.store.check(resourceId, address);
    this.cache.set(key, {
      value: allowed,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
    return allowed;
  }

  invalidateCache(principal: string): void {
    for (const key of this.cache.keys()) {
      if (key.endsWith(`:${principal}`)) {
        this.cache.delete(key);
      }
    }
  }

  private cacheKey(resourceId: string, address: string): string {
    return `${resourceId}:${address}`;
  }
}
