import type { Invoice, InvoiceStatus } from "./types.js";

export interface CreatorReputationScore {
  creator: string;
  completionRate: number;
  averageFundingTimeSeconds: number | null;
  disputeRate: number;
  totalInvoices: number;
  completedInvoices: number;
  disputedInvoices: number;
  overallScore: number;
}

export interface ReputationConfig {
  /** Weight for completion rate in overall score (0-1). Default: 0.4 */
  completionWeight?: number;
  /** Weight for average funding time in overall score (0-1). Default: 0.3 */
  fundingTimeWeight?: number;
  /** Weight for low dispute rate in overall score (0-1). Default: 0.3 */
  disputeWeight?: number;
  /** Maximum funding time (seconds) considered for best score. Default: 7 days. */
  maxFundingTimeSeconds?: number;
}

const DEFAULT_CONFIG: Required<ReputationConfig> = {
  completionWeight: 0.4,
  fundingTimeWeight: 0.3,
  disputeWeight: 0.3,
  maxFundingTimeSeconds: 604_800,
};

function terminatedOk(status: InvoiceStatus): boolean {
  return status === "Released";
}

function isDisputed(status: InvoiceStatus): boolean {
  return status === "Refunded";
}

export function computeCreatorReputation(
  invoices: Invoice[],
  config?: ReputationConfig
): CreatorReputationScore {
  const {
    completionWeight,
    fundingTimeWeight,
    disputeWeight,
    maxFundingTimeSeconds,
  } = { ...DEFAULT_CONFIG, ...config };

  const totalInvoices = invoices.length;

  if (totalInvoices === 0) {
    return {
      creator: "",
      completionRate: 0,
      averageFundingTimeSeconds: null,
      disputeRate: 0,
      totalInvoices: 0,
      completedInvoices: 0,
      disputedInvoices: 0,
      overallScore: 0,
    };
  }

  const creator = invoices[0]!.creator;

  const completedInvoices = invoices.filter((inv) => terminatedOk(inv.status)).length;
  const disputedInvoices = invoices.filter((inv) => isDisputed(inv.status)).length;

  const completionRate = totalInvoices > 0 ? completedInvoices / totalInvoices : 0;
  const disputeRate = totalInvoices > 0 ? disputedInvoices / totalInvoices : 0;

  const fundingTimes: number[] = [];
  for (const inv of invoices) {
    if (terminatedOk(inv.status) && inv.payments.length > 0) {
      const created = inv.deadline - 14 * 86400;
      const firstPayment = inv.payments.reduce(
        (earliest, p) => (p.timestamp && p.timestamp < earliest ? p.timestamp : earliest),
        Infinity
      );
      if (firstPayment !== Infinity) {
        fundingTimes.push(firstPayment - created);
      }
    }
  }

  const averageFundingTimeSeconds =
    fundingTimes.length > 0
      ? fundingTimes.reduce((a, b) => a + b, 0) / fundingTimes.length
      : null;

  const fundingTimeScore =
    averageFundingTimeSeconds !== null
      ? Math.max(0, 1 - averageFundingTimeSeconds / maxFundingTimeSeconds)
      : 0;

  const overallScore =
    completionRate * completionWeight +
    fundingTimeScore * fundingTimeWeight +
    (1 - disputeRate) * disputeWeight;

  return {
    creator,
    completionRate,
    averageFundingTimeSeconds,
    disputeRate,
    totalInvoices,
    completedInvoices,
    disputedInvoices,
    overallScore: Math.round(overallScore * 100) / 100,
  };
}
