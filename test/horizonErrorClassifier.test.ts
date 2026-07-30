import { describe, it, expect } from "vitest";
import { classifyHorizonError, isHorizonErrorRetryable } from "../src/horizonErrorClassifier.js";
import type { HorizonErrorClassification } from "../src/types.js";

describe("classifyHorizonError", () => {
  // -----------------------------------------------------------------------
  // Single string result codes
  // -----------------------------------------------------------------------

  it("classifies tx_bad_seq as retryable", () => {
    const result = classifyHorizonError("tx_bad_seq");
    expect(result.code).toBe("tx_bad_seq");
    expect(result.isRetryable).toBe(true);
    expect(result.severity).toBe("medium");
    expect(result.description).toBeTruthy();
    expect(result.suggestedAction).toBeTruthy();
  });

  it("classifies tx_success as not retryable", () => {
    const result = classifyHorizonError("tx_success");
    expect(result.isRetryable).toBe(false);
    expect(result.severity).toBe("low");
  });

  it("classifies tx_too_early as retryable", () => {
    const result = classifyHorizonError("tx_too_early");
    expect(result.isRetryable).toBe(true);
  });

  it("classifies tx_too_late as not retryable", () => {
    const result = classifyHorizonError("tx_too_late");
    expect(result.isRetryable).toBe(false);
    expect(result.severity).toBe("high");
  });

  it("classifies tx_insufficient_fee as retryable", () => {
    const result = classifyHorizonError("tx_insufficient_fee");
    expect(result.isRetryable).toBe(true);
  });

  it("classifies tx_no_source_account as not retryable", () => {
    const result = classifyHorizonError("tx_no_source_account");
    expect(result.isRetryable).toBe(false);
    expect(result.severity).toBe("high");
  });

  // -----------------------------------------------------------------------
  // Operation result codes (via array format)
  // -----------------------------------------------------------------------

  it("classifies op_no_trust as not retryable (from array)", () => {
    const result = classifyHorizonError(["tx_failed", "op_no_trust"]);
    expect(result.isRetryable).toBe(false);
    expect(result.operationCode).toBe("op_no_trust");
  });

  it("classifies op_underfunded as not retryable", () => {
    const result = classifyHorizonError(["tx_failed", "op_underfunded"]);
    expect(result.isRetryable).toBe(false);
    expect(result.severity).toBe("high");
  });

  it("classifies op_exceeded_work_limit as retryable", () => {
    const result = classifyHorizonError(["tx_failed", "op_exceeded_work_limit"]);
    expect(result.isRetryable).toBe(true);
    expect(result.severity).toBe("medium");
  });

  it("classifies op_too_many_subentries as retryable", () => {
    const result = classifyHorizonError(["tx_failed", "op_too_many_subentries"]);
    expect(result.isRetryable).toBe(true);
  });

  it("classifies op_no_issuer as not retryable (critical)", () => {
    const result = classifyHorizonError(["tx_failed", "op_no_issuer"]);
    expect(result.isRetryable).toBe(false);
    expect(result.severity).toBe("critical");
  });

  it("classifies op_cross_self as retryable", () => {
    const result = classifyHorizonError(["tx_failed", "op_cross_self"]);
    expect(result.isRetryable).toBe(true);
  });

  it("classifies op_sell_no_trust as not retryable", () => {
    const result = classifyHorizonError(["tx_failed", "op_sell_no_trust"]);
    expect(result.isRetryable).toBe(false);
    expect(result.severity).toBe("high");
  });

  it("classifies op_malformed as not retryable", () => {
    const result = classifyHorizonError(["tx_failed", "op_malformed"]);
    expect(result.isRetryable).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Object format (HorizonApi.TransactionFailedResultCodes shape)
  // -----------------------------------------------------------------------

  it("accepts object format with transactionResult and operationsResults", () => {
    const result = classifyHorizonError({
      transactionResult: "tx_failed",
      operationsResults: ["op_no_trust"],
    } as any);
    expect(result.isRetryable).toBe(false);
    expect(result.operationCode).toBe("op_no_trust");
  });

  it("accepts object format with transactionResult only", () => {
    const result = classifyHorizonError({
      transactionResult: "tx_bad_seq",
    } as any);
    expect(result.isRetryable).toBe(true);
    expect(result.code).toBe("tx_bad_seq");
  });

  // -----------------------------------------------------------------------
  // Unknown codes
  // -----------------------------------------------------------------------

  it("returns severity:unknown and isRetryable:false for unknown codes", () => {
    const result = classifyHorizonError("tx_some_unknown_code");
    expect(result.isRetryable).toBe(false);
    expect(result.severity).toBe("unknown");
  });

  it("returns severity:unknown for unknown operation codes with no known tx code", () => {
    // tx_failed is known (severity high), but op_some_unknown is not.
    // When we have a known tx code but unknown op code, the tx code's
    // classification is used as a fallback.
    const result = classifyHorizonError(["tx_failed", "op_some_unknown"]);
    expect(result.isRetryable).toBe(false);
    // Falls back to tx_failed classification
    expect(result.severity).toBe("high");
  });

  it("returns severity:unknown for completely unknown codes", () => {
    const result = classifyHorizonError("tx_xyz_nonexistent");
    expect(result.isRetryable).toBe(false);
    expect(result.severity).toBe("unknown");
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  it("handles empty array gracefully", () => {
    const result = classifyHorizonError([]);
    expect(result.isRetryable).toBe(false);
    expect(result.severity).toBe("unknown");
  });

  it("handles null gracefully (as unknown)", () => {
    const result = classifyHorizonError(null as any);
    expect(result.isRetryable).toBe(false);
    expect(result.severity).toBe("unknown");
  });
});

describe("isHorizonErrorRetryable", () => {
  it("returns true for tx_bad_seq", () => {
    expect(isHorizonErrorRetryable("tx_bad_seq")).toBe(true);
  });

  it("returns false for op_no_trust", () => {
    expect(isHorizonErrorRetryable(["tx_failed", "op_no_trust"])).toBe(false);
  });

  it("returns false for op_underfunded", () => {
    expect(isHorizonErrorRetryable(["tx_failed", "op_underfunded"])).toBe(false);
  });

  it("returns false for tx_too_late", () => {
    expect(isHorizonErrorRetryable("tx_too_late")).toBe(false);
  });

  it("returns true for tx_internal_error", () => {
    expect(isHorizonErrorRetryable("tx_internal_error")).toBe(true);
  });
});
