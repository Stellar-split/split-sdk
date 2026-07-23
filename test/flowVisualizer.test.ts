import { describe, expect, it } from "vitest";
import { generateFlowDiagram } from "../src/flowVisualizer.js";
import type { Invoice } from "../src/types.js";

describe("generateFlowDiagram", () => {
  it("returns Mermaid flowchart syntax with recipient nodes and payment edges", async () => {
    const invoice: Invoice = {
      id: "inv-1",
      creator: "GCREATOR",
      recipients: [
        { address: "GRECIPIENTA", amount: 100n },
        { address: "GRECIPIENTB", amount: 50n },
      ],
      token: "CUSDC",
      deadline: 1_900_000_000,
      funded: 120n,
      status: "Pending",
      payments: [{ payer: "GPAYER", amount: 120n }],
    };

    const diagram = await generateFlowDiagram("inv-1", async () => invoice);

    expect(diagram).toContain("flowchart LR");
    expect(diagram).toContain('creator_GCREATOR["Creator: GCREATOR"]');
    expect(diagram).toContain('invoice_inv_1["Invoice inv-1"]');
    expect(diagram).toContain('recipient_1_GRECIPIENTA["Recipient 1: GRECIPIENTA"]');
    expect(diagram).toContain('recipient_2_GRECIPIENTB["Recipient 2: GRECIPIENTB"]');
    expect(diagram).toContain('invoice_inv_1 -->|"100 / 100"| recipient_1_GRECIPIENTA');
    expect(diagram).toContain('invoice_inv_1 -->|"20 / 50"| recipient_2_GRECIPIENTB');
    expect(diagram).toContain("class recipient_1_GRECIPIENTA completed");
    expect(diagram).toContain("class recipient_2_GRECIPIENTB pending");
  });
});
