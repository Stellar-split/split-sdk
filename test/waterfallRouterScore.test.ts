import { describe, it, expect } from "vitest";
import { WaterfallRouter } from "../src/routing/WaterfallRouter.js";
import type { Invoice, WaterfallConfig } from "../src/types.js";

const mockInvoice: Invoice = {
  id: "inv-1",
  token: "native",
  creator: "GABC...",
  amount: 1000n,
  recipients: [],
  status: "pending",
  createdAt: new Date(),
  deadline: new Date(Date.now() + 86400000),
};

describe("WaterfallRouter route scoring", () => {
  it("sorts tiers by score descending", () => {
    const router = new WaterfallRouter();
    const config: WaterfallConfig = {
      tiers: [
        { recipient: "R1", minimumAmount: 100n, score: 1 },
        { recipient: "R2", minimumAmount: 100n, score: 10 },
        { recipient: "R3", minimumAmount: 100n, score: 5 },
      ],
    };

    const plan = router.plan(mockInvoice, 1000n, config);
    const order = plan.steps.map((s) => s.recipient);
    expect(order).toEqual(["R2", "R3", "R1"]);
  });

  it("falls back to declaration order on equal scores", () => {
    const router = new WaterfallRouter();
    const config: WaterfallConfig = {
      tiers: [
        { recipient: "R1", minimumAmount: 100n, score: 5 },
        { recipient: "R2", minimumAmount: 100n, score: 5 },
        { recipient: "R3", minimumAmount: 100n, score: 5 },
      ],
    };

    const plan = router.plan(mockInvoice, 1000n, config);
    const order = plan.steps.map((s) => s.recipient);
    expect(order).toEqual(["R1", "R2", "R3"]);
  });

  it("treats missing score as 0", () => {
    const router = new WaterfallRouter();
    const config: WaterfallConfig = {
      tiers: [
        { recipient: "R1", minimumAmount: 100n, score: 5 },
        { recipient: "R2", minimumAmount: 100n },
        { recipient: "R3", minimumAmount: 100n, score: -1 },
      ],
    };

    const plan = router.plan(mockInvoice, 1000n, config);
    const order = plan.steps.map((s) => s.recipient);
    expect(order).toEqual(["R1", "R2", "R3"]);
  });

  it("does not mutate the original config.tiers array", () => {
    const router = new WaterfallRouter();
    const tiers = [
      { recipient: "R1", minimumAmount: 100n, score: 1 },
      { recipient: "R2", minimumAmount: 100n, score: 10 },
    ];
    const config: WaterfallConfig = { tiers };

    router.plan(mockInvoice, 1000n, config);
    expect(tiers[0].recipient).toBe("R1");
    expect(tiers[1].recipient).toBe("R2");
  });
});
