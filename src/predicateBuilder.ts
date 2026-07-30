/**
 * Claimable Balance Predicate Builder — a fluent, type-safe wrapper around
 * `@stellar/stellar-sdk`'s `Claimant` predicate helpers, which otherwise
 * require directly composing `xdr.ClaimPredicate` unions by hand.
 */

import { Claimant, xdr } from "@stellar/stellar-sdk";
import type { PredicateConfig } from "./types.js";

export type ClaimPredicate = xdr.ClaimPredicate;

/** Fluent builder for Stellar claimable-balance claim predicates. */
export class PredicateBuilder {
  /** An always-claimable predicate. */
  static unconditional(): ClaimPredicate {
    return Claimant.predicateUnconditional();
  }

  /**
   * A predicate claimable only within `[startUnixSeconds, endUnixSeconds]`.
   *
   * @param startUnixSeconds - Unix timestamp (seconds) the balance becomes claimable.
   * @param endUnixSeconds - Unix timestamp (seconds) after which the balance can no longer be claimed.
   */
  static absoluteWindow(
    startUnixSeconds: number,
    endUnixSeconds: number,
  ): ClaimPredicate {
    const notBeforeStart = Claimant.predicateNot(
      Claimant.predicateBeforeAbsoluteTime(startUnixSeconds.toString()),
    );
    const beforeEnd = Claimant.predicateBeforeAbsoluteTime(
      endUnixSeconds.toString(),
    );
    return Claimant.predicateAnd(notBeforeStart, beforeEnd);
  }

  /**
   * A predicate claimable for the next `secondsFromNow` seconds (relative to
   * the ledger close time the claim transaction is applied in).
   */
  static relativeWindow(secondsFromNow: number): ClaimPredicate {
    return Claimant.predicateBeforeRelativeTime(secondsFromNow.toString());
  }

  /** Logical AND of two predicates — both must hold for the claim to succeed. */
  static and(a: ClaimPredicate, b: ClaimPredicate): ClaimPredicate {
    return Claimant.predicateAnd(a, b);
  }

  /** Logical OR of two predicates — either may hold for the claim to succeed. */
  static or(a: ClaimPredicate, b: ClaimPredicate): ClaimPredicate {
    return Claimant.predicateOr(a, b);
  }

  /** Build a `ClaimPredicate` from a declarative, JSON-serializable `PredicateConfig`. */
  static build(config: PredicateConfig): ClaimPredicate {
    switch (config.type) {
      case "unconditional":
        return PredicateBuilder.unconditional();
      case "absoluteWindow":
        return PredicateBuilder.absoluteWindow(config.start, config.end);
      case "relativeWindow":
        return PredicateBuilder.relativeWindow(config.secondsFromNow);
      case "and":
        return PredicateBuilder.and(
          PredicateBuilder.build(config.predicates[0]),
          PredicateBuilder.build(config.predicates[1]),
        );
      case "or":
        return PredicateBuilder.or(
          PredicateBuilder.build(config.predicates[0]),
          PredicateBuilder.build(config.predicates[1]),
        );
    }
  }
}
