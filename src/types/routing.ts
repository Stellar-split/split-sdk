/**
 * Types for waterfall payment routing (WaterfallRouter) and path-scoring.
 *
 * Amounts are always in stroops (bigint). `asset` is a Stellar asset
 * identifier: the invoice's own SEP-41 token contract address, or "native"
 * for XLM. A tier without an explicit `asset` defaults to the invoice's token.
 */

export type Asset = string;

/**
 * A single hop along a payment route used for path scoring.
 *
 * The `weight` field is advisory — it signals to the routing layer how
 * preferable this hop is relative to alternatives. Enforcement (e.g.
 * preferring higher-weight hops) is the responsibility of the router, not
 * this type definition.
 */
export interface RoutingHop {
  /** Asset to send into this hop (asset identifier or "native" for XLM). */
  sourceAsset: Asset;
  /** Asset to receive from this hop (asset identifier or "native" for XLM). */
  destAsset: Asset;
  /** Source amount in the asset's base unit (stroops for XLM). */
  sourceAmount: bigint;
  /** Estimated destination amount in the asset's base unit. */
  destAmount: bigint;
  /**
   * Advisory preference score for this hop in the range [0, 1].
   * A higher value indicates a more desirable hop (e.g. cheaper fee,
   * better reliability). When omitted, the routing layer treats this hop
   * as having neutral weight.
   */
  weight?: number;
}

/** A single ordered tier in a waterfall payout. */
export interface WaterfallTier {
  /** Stellar address of this tier's recipient. */
  recipient: string;
  /** Minimum amount (stroops) this tier must receive before lower tiers unlock. */
  minimumAmount: bigint;
  /** Asset for this tier. Defaults to the invoice's token when omitted. */
  asset?: Asset;
}

/** Ordered recipient tiers with minimum amounts, plus overflow behavior. */
export interface WaterfallConfig {
  /** Tiers in priority order (first tier is funded first). */
  tiers: WaterfallTier[];
  /** When true, submitPayment() accepts a plan with unsatisfied tiers. Default: false. */
  allowPartial?: boolean;
}

/** A single planned disbursement within a WaterfallPlan. */
export interface WaterfallStep {
  recipient: string;
  amount: bigint;
  asset: Asset;
  minimumAmount: bigint;
  /** False once availableAmount runs out; halts all downstream steps. */
  satisfied: boolean;
}

/** The sequenced payment plan produced by WaterfallRouter.plan(). */
export interface WaterfallPlan {
  steps: WaterfallStep[];
  /** True when every tier's minimumAmount was met. */
  fullySatisfied: boolean;
  /** Sum of amounts across all satisfied steps. */
  totalAllocated: bigint;
  /** availableAmount left over after allocating every satisfied tier. */
  remaining: bigint;
  /** Carried over from WaterfallConfig so submitPayment() doesn't need it re-passed. */
  allowPartial?: boolean;
}
