export type AuditActionType =
  | 'CREATE'
  | 'UPDATE_STATUS'
  | 'ADD_PAYMENT'
  | 'REROUTE_RECIPIENT'
  | 'REFUND'
  | string;

export interface AuditEvent {
  invoiceId: string;
  actorId: string;
  action: AuditActionType;
  payload: Record<string, any>;
  timestamp: number;
  ledger?: number;
}

export interface AuditChainEntry {
  event: AuditEvent;
  hash: string;
  prevHash: string;
  index: number;
}

export type AuditTrailRoot = string;

export interface CrossTenantAuditRecord {
  tenantId: string;
  invoiceId: string;
  event: AuditEvent;
  entry: AuditChainEntry;
  recordedAt: number;
}

export interface CrossTenantAuditQuery {
  tenantId?: string;
  invoiceId?: string;
}

export type CrossTenantAuditEvent =
  | { type: 'invoice.audited'; tenantId: string; invoiceId: string; entry: AuditChainEntry; timestamp: number }
  | { type: 'invoice.cross-tenant-access'; tenantId: string; invoiceId: string; entry: AuditChainEntry; timestamp: number }
  | { type: 'validation:start'; expectedRoot: AuditTrailRoot; length: number }
  | { type: 'validation:failure'; reason: string; mismatchAt: number }
  | { type: 'validation:success'; root: AuditTrailRoot; length: number };

export type CrossTenantAuditListener = (event: CrossTenantAuditEvent) => void;

export interface MerkleProofSibling {
  hash: string;
  position: 'left' | 'right';
}

export interface MerkleProof {
  leaf: string;
  index: number;
  siblings: MerkleProofSibling[];
  root: AuditTrailRoot;
}
