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

  constructor(store?: AsyncAclStore) {
    this.store = store ?? new InMemoryAclStore();
  }

  /**
   * Grant access to a resource for an address.
   *
   * @param resourceId - Resource identifier
   * @param address - Stellar address to grant access
   */
  async grant(resourceId: string, address: string): Promise<void> {
    await this.store.grant(resourceId, address);
  }

  /**
   * Revoke access to a resource for an address.
   *
   * @param resourceId - Resource identifier
   * @param address - Stellar address to revoke access
   */
  async revoke(resourceId: string, address: string): Promise<void> {
    await this.store.revoke(resourceId, address);
  }

  /**
   * Check if an address has access to a resource.
   *
   * @param resourceId - Resource identifier
   * @param address - Stellar address to check
   * @returns True if access is granted
   */
  async check(resourceId: string, address: string): Promise<boolean> {
    return this.store.check(resourceId, address);
  }
}
