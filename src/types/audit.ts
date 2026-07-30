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
