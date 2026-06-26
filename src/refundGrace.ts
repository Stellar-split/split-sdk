import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import type { Invoice } from "./types.js";

export interface RefundStatus {
  canRefund: boolean;
  refundAvailableAt: number;
  gracePeriodSecs: number;
}

export interface CanRefundOptions {
  gracePeriodSecs?: number;
  useOnChainTime?: boolean;
  server?: SorobanRpc.Server;
}

export async function canRefund(
  invoice: Invoice,
  options: CanRefundOptions = {},
): Promise<RefundStatus> {
  const gracePeriodSecs = options.gracePeriodSecs ?? 0;
  const refundAvailableAt = invoice.deadline + gracePeriodSecs;

  if (invoice.status !== "Pending") {
    return { canRefund: false, refundAvailableAt, gracePeriodSecs };
  }

  const now = options.useOnChainTime && options.server
    ? await getLedgerTime(options.server)
    : Math.floor(Date.now() / 1000);

  return { canRefund: now >= refundAvailableAt, refundAvailableAt, gracePeriodSecs };
}

async function getLedgerTime(server: SorobanRpc.Server): Promise<number> {
  const ledger = await server.getLatestLedger();
  const raw = ledger as { closedAt?: string };
  if (!raw.closedAt) {
    throw new Error(
      "RPC getLatestLedger did not return closedAt; cannot determine ledger time",
    );
  }
  return Math.floor(new Date(raw.closedAt).getTime() / 1000);
}
