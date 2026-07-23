import { describe, expect, it } from "vitest";
import {
  builtInNotificationTemplates,
  renderTemplate,
  type InvoiceEvent,
  type InvoiceEventType,
} from "../src/notificationTemplates.js";

describe("renderTemplate", () => {
  const eventTypes: InvoiceEventType[] = ["created", "payment", "released", "refunded", "expiring"];

  it("renders every built-in invoice event template", () => {
    for (const type of eventTypes) {
      const event: InvoiceEvent = {
        type,
        invoiceId: "inv-123",
        amount: 50_000_000n,
        creator: "GCREATOR",
      };

      const rendered = renderTemplate(event);

      expect(rendered).not.toContain("{{");
      expect(rendered).toContain("inv-123");
      expect(builtInNotificationTemplates[type]).toBeDefined();
    }
  });

  it("uses custom templates instead of built-ins", () => {
    const rendered = renderTemplate(
      {
        type: "payment",
        invoiceId: "inv-456",
        amount: 25n,
        creator: "GCREATOR",
      },
      "{{creator}} paid {{amount}} toward {{invoiceId}}"
    );

    expect(rendered).toBe("GCREATOR paid 25 toward inv-456");
  });
});
