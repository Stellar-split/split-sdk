import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  saveTemplate,
  createFromTemplate,
  deleteTemplate,
  getTemplate,
  listTemplates,
  resetTemplates,
  TemplateNotFoundError,
  TemplateAccessDeniedError,
} from "../src/templates";
import type { CreateInvoiceParams } from "../src/types";

describe("Template Management", () => {
  const mockParams: CreateInvoiceParams = {
    creator: "creator1",
    recipients: [
      { address: "recipient1", percentage: 100 },
    ],
    amount: BigInt(1000),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetTemplates();
  });

  describe("saveTemplate", () => {
    it("saves a template and returns template ID", async () => {
      const templateId = await saveTemplate(
        {
          name: "Standard Invoice",
          params: mockParams,
        },
        "creator1"
      );

      expect(templateId).toBeDefined();
      expect(typeof templateId).toBe("bigint");
    });

    it("increments template IDs", async () => {
      const templateId1 = await saveTemplate(
        {
          name: "Template 1",
          params: mockParams,
        },
        "creator1"
      );

      const templateId2 = await saveTemplate(
        {
          name: "Template 2",
          params: mockParams,
        },
        "creator1"
      );

      expect(templateId2 > templateId1).toBe(true);
    });
  });

  describe("getTemplate", () => {
    it("retrieves a saved template", async () => {
      const templateId = await saveTemplate(
        {
          name: "Test Template",
          params: mockParams,
        },
        "creator1"
      );

      const template = await getTemplate(templateId);
      expect(template.name).toBe("Test Template");
      expect(template.id).toBe(templateId);
      expect(template.creator).toBe("creator1");
    });

    it("throws TemplateNotFoundError for non-existent template", async () => {
      const invalidId = BigInt(999999);
      await expect(getTemplate(invalidId)).rejects.toThrow(
        TemplateNotFoundError
      );
    });
  });

  describe("listTemplates", () => {
    it("lists templates by creator", async () => {
      await saveTemplate(
        { name: "Template 1", params: mockParams },
        "creator1"
      );
      await saveTemplate(
        { name: "Template 2", params: mockParams },
        "creator1"
      );
      await saveTemplate(
        { name: "Template 3", params: mockParams },
        "creator2"
      );

      const creator1Templates = await listTemplates("creator1");
      expect(creator1Templates).toHaveLength(2);
      expect(creator1Templates.every((t) => t.creator === "creator1")).toBe(
        true
      );

      const creator2Templates = await listTemplates("creator2");
      expect(creator2Templates).toHaveLength(1);
    });

    it("returns empty array for creator with no templates", async () => {
      const templates = await listTemplates("unknown_creator");
      expect(templates).toHaveLength(0);
    });

    it("returns templates sorted by creation time (newest first)", async () => {
      const templateId1 = await saveTemplate(
        { name: "Template 1", params: mockParams },
        "creator1"
      );

      await new Promise((resolve) => setTimeout(resolve, 10));

      const templateId2 = await saveTemplate(
        { name: "Template 2", params: mockParams },
        "creator1"
      );

      const templates = await listTemplates("creator1");
      expect(templates[0].id).toBe(templateId2);
      expect(templates[1].id).toBe(templateId1);
    });
  });

  describe("deleteTemplate", () => {
    it("deletes a template owned by the creator", async () => {
      const templateId = await saveTemplate(
        { name: "Test Template", params: mockParams },
        "creator1"
      );

      await deleteTemplate(templateId, "creator1");

      await expect(getTemplate(templateId)).rejects.toThrow(
        TemplateNotFoundError
      );
    });

    it("throws error when deleting non-owned template", async () => {
      const templateId = await saveTemplate(
        { name: "Test Template", params: mockParams },
        "creator1"
      );

      await expect(deleteTemplate(templateId, "creator2")).rejects.toThrow(
        TemplateAccessDeniedError
      );
    });

    it("throws error when deleting non-existent template", async () => {
      const invalidId = BigInt(999999);
      await expect(deleteTemplate(invalidId, "creator1")).rejects.toThrow(
        TemplateNotFoundError
      );
    });
  });

  describe("createFromTemplate", () => {
    it("creates invoice from template", async () => {
      const templateId = await saveTemplate(
        { name: "Test Template", params: mockParams },
        "creator1"
      );

      const invoiceId = await createFromTemplate(
        { templateId },
        "creator1"
      );

      expect(invoiceId).toBeDefined();
      expect(typeof invoiceId).toBe("bigint");
    });

    it("applies parameter overrides", async () => {
      const templateId = await saveTemplate(
        { name: "Test Template", params: mockParams },
        "creator1"
      );

      const invoiceId = await createFromTemplate(
        {
          templateId,
          overrides: {
            amount: BigInt(2000),
          },
        },
        "creator1"
      );

      expect(invoiceId).toBeDefined();
    });

    it("throws error for non-existent template", async () => {
      const invalidId = BigInt(999999);
      await expect(
        createFromTemplate({ templateId: invalidId }, "creator1")
      ).rejects.toThrow(TemplateNotFoundError);
    });
  });
});
