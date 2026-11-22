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

/**
 * Sovereign identity integration (issue #1168).
 *
 * Approach: DID-style verifiable credentials (W3C VC data model).
 * Assumptions:
 * - Credentials are issued by trusted issuers identified by a DID string.
 * - Verification is performed off-chain; this module validates structure,
 *   issuer trust, expiry, and subject binding. Cryptographic signature
 *   verification is delegated to an injected verifier so callers can plug
 *   in their preferred DID method / crypto suite.
 * - Consent is tracked per subject and per credential purpose so that
 *   KYC/AML data is only used with explicit, revocable consent.
 */

export interface VerifiableCredential {
  id: string;
  issuer: string;
  subject: string;
  type: string[];
  issuanceDate: number;
  expirationDate?: number;
  claims: Record<string, unknown>;
  proof?: string;
}

export type CredentialVerifier = (
  credential: VerifiableCredential,
) => Promise<boolean>;

export interface IdentityVerificationOptions {
  trustedIssuers?: string[];
  requiredTypes?: string[];
  verifier?: CredentialVerifier;
  now?: () => number;
}

export interface VerificationResult {
  valid: boolean;
  reasons: string[];
}

export type ConsentPurpose = "kyc" | "aml" | "analytics";

export interface ConsentRecord {
  subject: string;
  purpose: ConsentPurpose;
  granted: boolean;
  updatedAt: number;
}

export interface IdentityAnalytics {
  verifications: number;
  successes: number;
  failures: number;
  consentsGranted: number;
  consentsRevoked: number;
}

/**
 * Manages sovereign identity verification, credential checking, consent,
 * and privacy-preserving analytics.
 */
export class SovereignIdentityManager {
  private readonly trustedIssuers: Set<string>;
  private readonly requiredTypes: string[];
  private readonly verifier?: CredentialVerifier;
  private readonly now: () => number;
  private readonly consents = new Map<string, ConsentRecord>();
  private readonly analytics: IdentityAnalytics = {
    verifications: 0,
    successes: 0,
    failures: 0,
    consentsGranted: 0,
    consentsRevoked: 0,
  };

  constructor(options: IdentityVerificationOptions = {}) {
    this.trustedIssuers = new Set(options.trustedIssuers ?? []);
    this.requiredTypes = options.requiredTypes ?? [];
    this.verifier = options.verifier;
    this.now = options.now ?? Date.now;
  }

  /**
   * Verify a credential for KYC/AML compliance.
   *
   * Checks structure, issuer trust, expiry, required types, subject
   * binding, and (when configured) the injected cryptographic verifier.
   */
  async verify(
    credential: VerifiableCredential,
    expectedSubject?: string,
  ): Promise<VerificationResult> {
    this.analytics.verifications++;
    const reasons: string[] = [];

    if (!credential.id || !credential.issuer || !credential.subject) {
      reasons.push("missing required credential fields");
    }
    if (this.trustedIssuers.size > 0 && !this.trustedIssuers.has(credential.issuer)) {
      reasons.push(`untrusted issuer: ${credential.issuer}`);
    }
    if (expectedSubject && credential.subject !== expectedSubject) {
      reasons.push("subject mismatch");
    }
    if (
      credential.expirationDate !== undefined &&
      credential.expirationDate <= this.now()
    ) {
      reasons.push("credential expired");
    }
    for (const type of this.requiredTypes) {
      if (!credential.type.includes(type)) {
        reasons.push(`missing required type: ${type}`);
      }
    }
    if (this.verifier) {
      const proofValid = await this.verifier(credential);
      if (!proofValid) {
        reasons.push("proof verification failed");
      }
    }

    const valid = reasons.length === 0;
    if (valid) {
      this.analytics.successes++;
    } else {
      this.analytics.failures++;
    }
    return { valid, reasons };
  }

  /**
   * Grant consent for a subject to use their identity data for a purpose.
   */
  grantConsent(subject: string, purpose: ConsentPurpose): ConsentRecord {
    const record: ConsentRecord = {
      subject,
      purpose,
      granted: true,
      updatedAt: this.now(),
    };
    this.consents.set(this.consentKey(subject, purpose), record);
    this.analytics.consentsGranted++;
    return record;
  }

  /**
   * Revoke previously granted consent.
   */
  revokeConsent(subject: string, purpose: ConsentPurpose): ConsentRecord {
    const record: ConsentRecord = {
      subject,
      purpose,
      granted: false,
      updatedAt: this.now(),
    };
    this.consents.set(this.consentKey(subject, purpose), record);
    this.analytics.consentsRevoked++;
    return record;
  }

  /**
   * Check whether consent is currently granted for a purpose.
   */
  hasConsent(subject: string, purpose: ConsentPurpose): boolean {
    return this.consents.get(this.consentKey(subject, purpose))?.granted ?? false;
  }

  /**
   * Return a snapshot of identity analytics (no PII included).
   */
  getAnalytics(): IdentityAnalytics {
    return { ...this.analytics };
  }

  private consentKey(subject: string, purpose: ConsentPurpose): string {
    return `${subject}:${purpose}`;
  }
}

/**
 * Key access control (issue #1254).
 *
 * Provides per-key access rules for the secure key store. Rules are
 * evaluated before any key material is read or rotated, and every denied
 * attempt is emitted as an audit event so that unauthorized access is
 * observable without exposing key material.
 */

export interface KeyAccessRule {
  /** Principal (Stellar address or service identity) allowed by the rule. */
  principal: string;
  /** Operations the principal may perform on the key. */
  operations: KeyOperation[];
}

export type KeyOperation = "read" | "rotate" | "use";

export interface KeyAccessDeniedEvent {
  keyId: string;
  principal: string;
  operation: KeyOperation;
  reason: string;
  timestamp: number;
}

export type KeyAccessDeniedListener = (event: KeyAccessDeniedEvent) => void;

export interface KeyAccessPolicyOptions {
  /** Default operations granted when no explicit rule matches. */
  defaultOperations?: KeyOperation[];
  now?: () => number;
}

/**
 * Evaluates per-key access rules and emits audit events on denial.
 *
 * Rules are keyed by key id and principal. When no rule exists for a
 * principal, the configured default operations apply (none by default),
 * ensuring deny-by-default semantics.
 */
export class KeyAccessPolicy {
  private readonly rules = new Map<string, Map<string, Set<KeyOperation>>>();
  private readonly defaultOperations: Set<KeyOperation>;
  private readonly listeners = new Set<KeyAccessDeniedListener>();
  private readonly now: () => number;

  constructor(options: KeyAccessPolicyOptions = {}) {
    this.defaultOperations = new Set(options.defaultOperations ?? []);
    this.now = options.now ?? Date.now;
  }

  /**
   * Register a listener for access-denied audit events.
   *
   * @returns An unsubscribe function.
   */
  onAccessDenied(listener: KeyAccessDeniedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Define (or replace) the access rule for a principal on a key.
   */
  setRule(keyId: string, rule: KeyAccessRule): void {
    let principals = this.rules.get(keyId);
    if (!principals) {
      principals = new Map();
      this.rules.set(keyId, principals);
    }
    principals.set(rule.principal, new Set(rule.operations));
  }

  /**
   * Remove the access rule for a principal on a key.
   */
  removeRule(keyId: string, principal: string): void {
    this.rules.get(keyId)?.delete(principal);
  }

  /**
   * Check whether a principal may perform an operation on a key.
   *
   * Emits an access-denied audit event when the operation is not allowed.
   */
  check(keyId: string, principal: string, operation: KeyOperation): boolean {
    const allowed = this.isAllowed(keyId, principal, operation);
    if (!allowed) {
      this.emitDenied({
        keyId,
        principal,
        operation,
        reason: "operation not permitted by key access policy",
        timestamp: this.now(),
      });
    }
    return allowed;
  }

  /**
   * Assert that a principal may perform an operation, throwing otherwise.
   *
   * The thrown error never includes key material.
   */
  assert(keyId: string, principal: string, operation: KeyOperation): void {
    if (!this.check(keyId, principal, operation)) {
      throw new Error(
        `Access denied: ${principal} may not ${operation} key ${keyId}`,
      );
    }
  }

  private isAllowed(
    keyId: string,
    principal: string,
    operation: KeyOperation,
  ): boolean {
    const operations =
      this.rules.get(keyId)?.get(principal) ?? this.defaultOperations;
    return operations.has(operation);
  }

  private emitDenied(event: KeyAccessDeniedEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

export type WithdrawalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "executed";

export interface WithdrawalRequest {
  id: string;
  resourceId: string;
  requester: string;
  amount: string;
  status: WithdrawalStatus;
  approvals: string[];
  rejections: string[];
  createdAt: number;
  updatedAt: number;
}

export interface WithdrawalApprovalOptions {
  requiredApprovals?: number;
  acl?: AclManager;
}

export type WithdrawalEventType =
  | "submitted"
  | "approved"
  | "rejected"
  | "executed";

export interface WithdrawalEvent {
  type: WithdrawalEventType;
  request: WithdrawalRequest;
  actor: string;
  timestamp: number;
}

export type WithdrawalEventListener = (event: WithdrawalEvent) => void;

/**
 * Manages custody withdrawal approval workflows.
 *
 * A withdrawal request moves through a multi-step approval state machine:
 * pending -> approved (once enough approvals are collected) -> executed,
 * or pending -> rejected. Approvers must hold access to the resource
 * when an AclManager is provided.
 */
export class WithdrawalApprovalWorkflow {
  private readonly requiredApprovals: number;
  private readonly acl?: AclManager;
  private readonly requests = new Map<string, WithdrawalRequest>();
  private readonly listeners = new Set<WithdrawalEventListener>();

  constructor(options: WithdrawalApprovalOptions = {}) {
    this.requiredApprovals = options.requiredApprovals ?? 1;
    if (this.requiredApprovals < 1) {
      throw new Error("requiredApprovals must be at least 1");
    }
    this.acl = options.acl;
  }

  /**
   * Register a listener for withdrawal lifecycle events.
   *
   * @returns An unsubscribe function.
   */
  onEvent(listener: WithdrawalEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Submit a new withdrawal request in the pending state.
   */
  async submit(params: {
    id: string;
    resourceId: string;
    requester: string;
    amount: string;
  }): Promise<WithdrawalRequest> {
    if (this.requests.has(params.id)) {
      throw new Error(`Withdrawal request ${params.id} already exists`);
    }
    const now = Date.now();
    const request: WithdrawalRequest = {
      id: params.id,
      resourceId: params.resourceId,
      requester: params.requester,
      amount: params.amount,
      status: "pending",
      approvals: [],
      rejections: [],
      createdAt: now,
      updatedAt: now,
    };
    this.requests.set(request.id, request);
    this.emit("submitted", request, params.requester);
    return request;
  }

  /**
   * Approve a pending withdrawal request.
   */
  async approve(id: string, approver: string): Promise<WithdrawalRequest> {
    const request = this.getRequest(id);
    if (request.status !== "pending") {
      throw new Error(`Cannot approve request in status ${request.status}`);
    }
    if (approver === request.requester) {
      throw new Error("Requester cannot approve their own withdrawal");
    }
    if (request.approvals.includes(approver)) {
      throw new Error(`Approver ${approver} has already approved`);
    }
    if (this.acl && !(await this.acl.check(request.resourceId, approver))) {
      throw new Error(`Approver ${approver} lacks access to resource`);
    }

    request.approvals.push(approver);
    request.updatedAt = Date.now();
    if (request.approvals.length >= this.requiredApprovals) {
      request.status = "approved";
    }
    this.emit("approved", request, approver);
    return request;
  }

  /**
   * Reject a pending withdrawal request.
   */
  async reject(id: string, rejector: string): Promise<WithdrawalRequest> {
    const request = this.getRequest(id);
    if (request.status !== "pending") {
      throw new Error(`Cannot reject request in status ${request.status}`);
    }
    if (request.rejections.includes(rejector)) {
      throw new Error(`Rejector ${rejector} has already rejected`);
    }
    if (this.acl && !(await this.acl.check(request.resourceId, rejector))) {
      throw new Error(`Rejector ${rejector} lacks access to resource`);
    }

    request.rejections.push(rejector);
    request.status = "rejected";
    request.updatedAt = Date.now();
    this.emit("rejected", request, rejector);
    return request;
  }

  /**
   * Execute an approved withdrawal request.
   */
  async execute(id: string, executor: string): Promise<WithdrawalRequest> {
    const request = this.getRequest(id);
    if (request.status !== "approved") {
      throw new Error(`Cannot execute request in status ${request.status}`);
    }
    request.status = "executed";
    request.updatedAt = Date.now();
    this.emit("executed", request, executor);
    return request;
  }

  /**
   * Retrieve a withdrawal request by id.
   */
  get(id: string): WithdrawalRequest | undefined {
    return this.requests.get(id);
  }

  private getRequest(id: string): WithdrawalRequest {
    const request = this.requests.get(id);
    if (!request) {
      throw new Error(`Withdrawal request ${id} not found`);
    }
    return request;
  }

  private emit(
    type: WithdrawalEventType,
    request: WithdrawalRequest,
    actor: string,
  ): void {
    const event: WithdrawalEvent = {
      type,
      request,
      actor,
      timestamp: Date.now(),
    };
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
