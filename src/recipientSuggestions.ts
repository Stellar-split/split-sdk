/**
 * Recipient suggestions API — issue #1051
 *
 * Suggests recipients to pay based on past payment history and a contact
 * list.  The scorer combines a frequency signal (how often a recipient has
 * been paid) with a recency signal (how recently they were last paid) into a
 * deterministic [0, 1] score.  Callers can filter results by excluding
 * addresses and/or applying a minimum score threshold, and results are ranked
 * highest-score first with stable address-based tie-breaking.
 *
 * The suggester is intentionally stateless: callers supply the history and
 * candidate contacts on each call, so the SDK does not need to own a
 * persistence layer for contact data.
 */

import type { Recipient } from "./types.js";
import { ValidationError } from "./errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A recorded interaction with a recipient (e.g. a past payment). */
export interface RecipientInteraction {
  /** Stellar address of the recipient. */
  address: string;
  /** Amount sent in the interaction, in stroops. */
  amount: bigint;
  /** Unix timestamp in seconds when the interaction occurred. */
  timestamp: number;
}

/** A single suggested recipient with its composite score and rationale. */
export interface RecipientSuggestion {
  /** Stellar address of the suggested recipient. */
  address: string;
  /** Composite score in the range [0, 1]; higher is a stronger match. */
  score: number;
  /** Human-readable explanation for why this recipient was suggested. */
  reason: string;
  /** Number of past interactions with this recipient. */
  interactionCount: number;
  /** Unix timestamp of the most recent interaction, if any. */
  lastInteraction?: number;
}

/**
 * Explicit feedback recorded for a suggested recipient.  Positive feedback
 * (accepted) boosts a recipient's learned affinity; negative feedback
 * (rejected) penalises it.  Feedback is keyed by address and accumulated.
 */
export interface RecipientFeedback {
  /** Stellar address the feedback applies to. */
  address: string;
  /** Whether the suggestion was accepted (true) or dismissed (false). */
  accepted: boolean;
  /** Unix timestamp in seconds when the feedback was recorded. */
  timestamp: number;
}

/**
 * Optional metadata used to filter candidates by asset, network or tags.
 * Candidates without metadata are only filtered out when a filter is set.
 */
export interface RecipientMetadata {
  /** Asset code the recipient prefers to receive (e.g. "XLM", "USDC"). */
  asset?: string;
  /** Network identifier the recipient operates on (e.g. "testnet"). */
  network?: string;
  /** Free-form tags associated with the recipient. */
  tags?: string[];
}

/** Filtering criteria applied to candidates before scoring. */
export interface RecipientSuggestionFilter {
  /** Only suggest recipients whose metadata asset matches. */
  asset?: string;
  /** Only suggest recipients whose metadata network matches. */
  network?: string;
  /** Only suggest recipients whose metadata tags include all of these. */
  tags?: string[];
}

/** Aggregate statistics describing suggestion quality over time. */
export interface SuggestionStats {
  /** Total number of suggestions served across all calls. */
  served: number;
  /** Total number of suggestions accepted via feedback. */
  accepted: number;
  /** Total number of suggestions rejected via feedback. */
  rejected: number;
  /** Accepted / served ratio in [0, 1]; 0 when nothing has been served. */
  hitRate: number;
}

/** Input candidates for a suggestion run. */
export interface SuggestRecipientsOptions {
  /**
   * Contact addresses eligible for suggestion.  When omitted, candidates are
   * derived from the supplied history.
   */
  candidates?: string[];
  /** Past interactions used by the matcher to learn recipient preferences. */
  history: RecipientInteraction[];
  /** Addresses that must never be suggested. */
  exclude?: string[];
  /**
   * Minimum composite score [0, 1] required to be included in results.
   * @default 0
   */
  minScore?: number;
  /** Maximum number of suggestions to return. @default 10 */
  limit?: number;
  /**
   * Unix timestamp in seconds representing "now" for recency scoring.
   * Defaults to Date.now() / 1000.
   */
  nowSeconds?: number;
  /** Optional metadata keyed by address, used for asset/network/tag filters. */
  metadata?: Record<string, RecipientMetadata>;
  /** Optional asset/network/tag filtering criteria. */
  filter?: RecipientSuggestionFilter;
  /**
   * Recorded feedback used to learn recipient affinities.  Accepted feedback
   * boosts a recipient's score; rejected feedback lowers it.
   */
  feedback?: RecipientFeedback[];
}

/** Weight applied to the frequency signal in the composite score. */
const FREQUENCY_WEIGHT = 0.6;
/** Weight applied to the recency signal in the composite score. */
const RECENCY_WEIGHT = 0.4;
/** Weight applied to the learned feedback signal in the composite score. */
const FEEDBACK_WEIGHT = 0.2;
/** Score delta applied per net accepted feedback, capped by the weight. */
const FEEDBACK_STEP = 0.1;

/**
 * Default maximum number of suggestions returned per call.
 */
export const DEFAULT_SUGGESTION_LIMIT = 10;

/**
 * Default recency half-life in seconds: a recipient last paid this long ago
 * scores 0.5 on the recency signal (before weighting).
 */
const RECENCY_HALF_LIFE_SECONDS = 30 * 24 * 60 * 60; // 30 days

/**
 * Compute a learned feedback signal in [0, 1] for an address from recorded
 * feedback.  Net accepted feedback is scaled by {@link FEEDBACK_STEP} and
 * clamped to the {@link FEEDBACK_WEIGHT} ceiling; a neutral 0.5 baseline is
 * used when no feedback exists so the signal does not distort cold recipients.
 */
function feedbackSignal(
  address: string,
  feedback: RecipientFeedback[] | undefined,
): number {
  if (!feedback || feedback.length === 0) return 0.5;
  let net = 0;
  for (const f of feedback) {
    if (f.address !== address) continue;
    net += f.accepted ? 1 : -1;
  }
  const delta = net * FEEDBACK_STEP;
  const clamped = Math.max(-FEEDBACK_WEIGHT, Math.min(FEEDBACK_WEIGHT, delta));
  return 0.5 + clamped;
}

/**
 * Determine whether a candidate passes the asset/network/tag filter.  When no
 * filter is supplied every candidate passes.  Candidates lacking metadata are
 * rejected only when the corresponding filter criterion is set.
 */
function passesFilter(
  address: string,
  filter: RecipientSuggestionFilter | undefined,
  metadata: Record<string, RecipientMetadata> | undefined,
): boolean {
  if (!filter) return true;
  const meta = metadata?.[address];
  if (filter.asset !== undefined) {
    if (!meta || meta.asset !== filter.asset) return false;
  }
  if (filter.network !== undefined) {
    if (!meta || meta.network !== filter.network) return false;
  }
  if (filter.tags?.length) {
    const tags = new Set(meta?.tags ?? []);
    for (const tag of filter.tags) {
      if (!tags.has(tag)) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Statistics tracking
// ---------------------------------------------------------------------------

const stats: SuggestionStats = {
  served: 0,
  accepted: 0,
  rejected: 0,
  hitRate: 0,
};

function recomputeHitRate(): void {
  stats.hitRate = stats.served > 0 ? stats.accepted / stats.served : 0;
}

/**
 * Return a snapshot of the accumulated suggestion statistics.  The returned
 * object is a copy and can be safely mutated by the caller.
 */
export function getSuggestionStats(): SuggestionStats {
  return { ...stats };
}

/** Reset accumulated suggestion statistics (primarily for tests). */
export function resetSuggestionStats(): void {
  stats.served = 0;
  stats.accepted = 0;
  stats.rejected = 0;
  stats.hitRate = 0;
}

/**
 * Record feedback for a previously served suggestion, updating the learned
 * affinity and the aggregate statistics.  Returns the updated stats snapshot.
 */
export function recordSuggestionFeedback(
  feedback: RecipientFeedback,
): SuggestionStats {
  if (!feedback || typeof feedback.address !== "string") {
    throw new ValidationError("feedback.address must be a string");
  }
  if (feedback.accepted) {
    stats.accepted += 1;
  } else {
    stats.rejected += 1;
  }
  recomputeHitRate();
  return getSuggestionStats();
}

/**
 * Build ranked recipient suggestions from history and optional contacts.
 *
 * Implements matcher (frequency + recency + learned feedback scoring),
 * filtering (exclude list, asset/network/tag filter and min-score threshold)
 * and ranking (score-descending, stable tie-break).
 */
export function suggestRecipients(
  options: SuggestRecipientsOptions,
): RecipientSuggestion[] {
  if (!options.history || !Array.isArray(options.history)) {
    throw new ValidationError("options.history must be an array");
  }

  const nowSeconds = options.nowSeconds ?? Date.now() / 1000;
  const exclude = new Set(options.exclude ?? []);
  const limit = options.limit ?? DEFAULT_SUGGESTION_LIMIT;
  const minScore = options.minScore ?? 0;

  // Derive the candidate set: explicit contacts restrict the pool; when none
  // are provided, candidates are derived from the supplied history.
  const candidateSet = new Set<string>();
  if (options.candidates?.length) {
    for (const c of options.candidates) {
      if (typeof c === "string" && c.length > 0) candidateSet.add(c);
    }
  } else {
    for (const h of options.history) {
      if (typeof h.address === "string" && h.address.length > 0) {
        candidateSet.add(h.address);
      }
    }
  }

  // First pass: score every candidate and track the max frequency for
  // normalizing the frequency signal across candidates.
  const perCandidate: Array<{
    address: string;
    interactionCount: number;
    lastInteraction?: number;
    recencyScore: number;
  }> = [];

  // Pre-index history by address so scoring is O(candidates + history)
  // rather than O(candidates * history).
  const historyByAddress = new Map<string, RecipientInteraction[]>();
  for (const h of options.history) {
    if (typeof h.address !== "string" || h.address.length === 0) continue;
    const bucket = historyByAddress.get(h.address);
    if (bucket) bucket.push(h);
    else historyByAddress.set(h.address, [h]);
  }

  let maxFrequency = 0;
  for (const address of candidateSet) {
    if (exclude.has(address)) continue;
    if (!passesFilter(address, options.filter, options.metadata)) continue;

    const interactions = historyByAddress.get(address) ?? [];
    const interactionCount = interactions.length;
    if (interactionCount === 0) continue; // no history → not a suggestion

    const timestamps = interactions.map((h) => h.timestamp);
    const lastInteraction = Math.max(...timestamps);
    const ageSeconds = Math.max(0, nowSeconds - lastInteraction);
    const recencyScore = 1 / (1 + ageSeconds / RECENCY_HALF_LIFE_SECONDS);

    if (interactionCount > maxFrequency) maxFrequency = interactionCount;

    perCandidate.push({
      address,
      interactionCount,
      lastInteraction,
      recencyScore,
    });
  }

  // Second pass: normalize frequency, combine with recency and learned
  // feedback, filter, rank.
  const scored: RecipientSuggestion[] = perCandidate.map((c) => {
    const frequencyScore =
      maxFrequency > 0 ? c.interactionCount / maxFrequency : 0; // (0, 1]
    const learned = feedbackSignal(c.address, options.feedback);
    const score =
      FREQUENCY_WEIGHT * frequencyScore +
      RECENCY_WEIGHT * c.recencyScore +
      FEEDBACK_WEIGHT * learned;

    let reason: string;
    if (c.interactionCount === 1) {
      reason = "Paid once previously";
    } else {
      reason = `Paid ${c.interactionCount} times`;
    }
    if (learned > 0.5) {
      reason += " (accepted before)";
    } else if (learned < 0.5) {
      reason += " (dismissed before)";
    }

    return {
      address: c.address,
      score: Math.min(1, Math.max(0, score)),
      reason,
      interactionCount: c.interactionCount,
      lastInteraction: c.lastInteraction,
    };
  });

  const filtered = scored.filter((s) => s.score >= minScore);

  // Sort descending by score; break ties by address for determinism.
  filtered.sort((a, b) => {
    const diff = b.score - a.score;
    if (diff !== 0) return diff;
    return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
  });

  const results = filtered.slice(0, limit);
  stats.served += results.length;
  recomputeHitRate();
  return results;
}

/**
 * Convert a {@link Recipient} (as used in invoice creation) into a
 * {@link RecipientInteraction} suitable for recording in suggestion history.
 */
export function interactionFromRecipient(
  recipient: Recipient,
  timestamp: number,
): RecipientInteraction {
  return {
    address: recipient.address,
    amount: recipient.amount,
    timestamp,
  };
}

