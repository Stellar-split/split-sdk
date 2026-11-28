/**
 * Payment split calculator.
 *
 * Computes per-recipient shares from a total amount and a set of split
 * definitions. Supports percentage and fixed-amount splits, with optional
 * remainder distribution so that the sum of all shares always equals the
 * original total.
 */

export type SplitKind = "percentage" | "fixed";

export interface SplitDefinition {
  /** Identifier of the recipient receiving this share. */
  recipientId: string;
  /** How the share is expressed: a percentage of the total or a fixed amount. */
  kind: SplitKind;
  /** Percentage (0-100) when kind is "percentage", or an absolute amount when "fixed". */
  value: number;
}

export interface SplitShare {
  recipientId: string;
  /** Amount allocated to the recipient, in the smallest currency unit. */
  amount: number;
}

export interface SplitResult {
  total: number;
  shares: SplitShare[];
  /** Amount left unallocated after applying all definitions. */
  remainder: number;
}

export type SplitEventType = "split:computed" | "split:error";

export interface SplitComputedEvent {
  type: "split:computed";
  result: SplitResult;
}

export interface SplitErrorEvent {
  type: "split:error";
  error: Error;
}

export type SplitEvent = SplitComputedEvent | SplitErrorEvent;

export type SplitEventListener = (event: SplitEvent) => void;

export interface PaymentSplitCalculatorOptions {
  /**
   * When true, any unallocated remainder is distributed one unit at a time
   * across recipients (in definition order) so the shares sum to the total.
   */
  distributeRemainder?: boolean;
}

/**
 * Calculates how a total amount is split across recipients.
 */
export class PaymentSplitCalculator {
  private readonly listeners: Set<SplitEventListener> = new Set();
  private readonly distributeRemainder: boolean;

  constructor(options: PaymentSplitCalculatorOptions = {}) {
    this.distributeRemainder = options.distributeRemainder ?? false;
  }

  /**
   * Registers a listener for split lifecycle events.
   * @returns an unsubscribe function.
   */
  public on(listener: SplitEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Computes the per-recipient shares for the given total and definitions.
   *
   * @throws {Error} when the total is negative, a definition is invalid, or
   * the definitions allocate more than the total.
   */
  public calculate(total: number, definitions: SplitDefinition[]): SplitResult {
    try {
      const result = this.compute(total, definitions);
      this.emit({ type: "split:computed", result });
      return result;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.emit({ type: "split:error", error: normalized });
      throw normalized;
    }
  }

  private compute(total: number, definitions: SplitDefinition[]): SplitResult {
    if (!Number.isFinite(total) || total < 0) {
      throw new Error("Total amount must be a non-negative finite number");
    }

    const shares: SplitShare[] = [];
    let allocated = 0;

    for (const definition of definitions) {
      if (!definition || typeof definition.recipientId !== "string" || definition.recipientId.length === 0) {
        throw new Error("Each split definition requires a non-empty recipientId");
      }
      if (!Number.isFinite(definition.value) || definition.value < 0) {
        throw new Error(`Invalid split value for recipient ${definition.recipientId}`);
      }

      let amount: number;
      if (definition.kind === "percentage") {
        if (definition.value > 100) {
          throw new Error(`Percentage for recipient ${definition.recipientId} exceeds 100`);
        }
        amount = Math.round((total * definition.value) / 100);
      } else if (definition.kind === "fixed") {
        amount = Math.round(definition.value);
      } else {
        throw new Error(`Unsupported split kind for recipient ${definition.recipientId}`);
      }

      allocated += amount;
      shares.push({ recipientId: definition.recipientId, amount });
    }

    if (allocated > total) {
      throw new Error("Split definitions allocate more than the total amount");
    }

    let remainder = total - allocated;

    if (this.distributeRemainder && remainder > 0 && shares.length > 0) {
      let index = 0;
      while (remainder > 0) {
        shares[index % shares.length]!.amount += 1;
        remainder -= 1;
        index += 1;
      }
      remainder = 0;
    }

    return { total, shares, remainder };
  }

  private emit(event: SplitEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
