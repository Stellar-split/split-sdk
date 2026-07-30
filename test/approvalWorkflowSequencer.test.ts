import { describe, expect, it, vi } from "vitest";
import { ApprovalWorkflowSequencer } from "../src/approvalWorkflowSequencer.js";

describe("ApprovalWorkflowSequencer", () => {
  it("resolves a 2-of-3 flow on the second valid signature", () => {
    const notifySigner = vi.fn();
    const sequencer = new ApprovalWorkflowSequencer({
      notifySigner,
      applySignatures: (xdr, signatures) => `${xdr}:${signatures.size}`,
    });

    const session = sequencer.initiate("tx-xdr", {
      threshold: 2,
      timeoutMs: 1_000,
      signers: [
        { publicKey: "G1", weight: 1 },
        { publicKey: "G2", weight: 1 },
        { publicKey: "G3", weight: 1 },
      ],
    });

    expect(notifySigner).toHaveBeenCalledTimes(3);
    expect(session.submitSignature("G1", "sig-1")).toEqual({ complete: false, weight: 1 });
    expect(session.submitSignature("G2", "sig-2")).toEqual({ complete: true, weight: 2 });
    expect(session.getSignedXdr()).toBe("tx-xdr:2");
  });
});
