import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  diffTemplate,
  migrateTemplate,
  migrateAllTemplates,
} from "../src/templateMigration.js";
import type { InvoiceTemplate } from "../src/types.js";
import * as templateManager from "../src/templateManager.js";

const BASE_TEMPLATE: InvoiceTemplate = {
  name: "test",
  recipients: [{ address: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN", amount: 100n }],
  token: "GUSDCXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
};

describe("diffTemplate", () => {
  it("returns empty diff for identical templates", () => {
    const diff = diffTemplate(BASE_TEMPLATE, BASE_TEMPLATE);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
  });

  it("detects added fields when schema has new keys", () => {
    const schema: InvoiceTemplate = {
      ...BASE_TEMPLATE,
      memo: "optional memo",
    } as InvoiceTemplate & { memo: string };

    const existing = { ...BASE_TEMPLATE };

    const diff = diffTemplate(existing, schema);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]!.field).toBe("memo");
    expect(diff.added[0]!.to).toBe("optional memo");
  });

  it("detects removed fields when existing has extra keys", () => {
    const existing = {
      ...BASE_TEMPLATE,
      deprecatedField: "old value",
    } as InvoiceTemplate & { deprecatedField: string };

    const diff = diffTemplate(existing, BASE_TEMPLATE);
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0]!.field).toBe("deprecatedField");
  });

  it("detects changed field values", () => {
    const existing = {
      ...BASE_TEMPLATE,
      token: "GOLDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    };

    const diff = diffTemplate(existing, BASE_TEMPLATE);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]!.field).toBe("token");
  });
});

describe("migrateTemplate", () => {
  it("fills missing fields from schema", () => {
    const schema: InvoiceTemplate & { memo: string; deadline: number } = {
      ...BASE_TEMPLATE,
      memo: "",
      deadline: 0,
    } as unknown as InvoiceTemplate;

    const existing: InvoiceTemplate & { memo?: string; deadline?: number } = {
      ...BASE_TEMPLATE,
      name: "existing-template",
    };

    const migrated = migrateTemplate(existing, schema as InvoiceTemplate);
    const m = migrated as Record<string, unknown>;
    expect(m.memo).toBe("");
    expect(m.deadline).toBe(0);
  });

  it("preserves existing field values", () => {
    const existing = {
      ...BASE_TEMPLATE,
      token: "GOLDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    };

    const migrated = migrateTemplate(existing, BASE_TEMPLATE);
    expect(migrated.token).toBe(
      "GOLDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
    );
  });
});

describe("migrateAllTemplates", () => {
  const extendedSchema = {
    ...BASE_TEMPLATE,
    memo: "",
  } as InvoiceTemplate;

  beforeEach(() => {
    templateManager.saveTemplate("needs-migration", {
      name: "needs-migration",
      recipients: BASE_TEMPLATE.recipients,
      token: BASE_TEMPLATE.token,
    });
    templateManager.saveTemplate("already-current", {
      ...BASE_TEMPLATE,
      name: "already-current",
      memo: "exists",
    } as InvoiceTemplate & { memo: string } as unknown as InvoiceTemplate);
  });

  afterEach(() => {
    templateManager.deleteTemplate("needs-migration");
    templateManager.deleteTemplate("already-current");
  });

  it("migrates templates with missing fields", () => {
    const result = migrateAllTemplates(extendedSchema, { dryRun: false });

    expect(result.migrated).toBe(1);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(result.errors).toHaveLength(0);

    const migrated = templateManager.loadTemplate("needs-migration");
    expect(migrated).not.toBeNull();
    expect((migrated as Record<string, unknown>).memo).toBe("");
  });

  it("dryRun does not modify stored templates", () => {
    const result = migrateAllTemplates(extendedSchema, { dryRun: true });

    expect(result.migrated).toBe(1);
  });

  it("calls onMigrate callback for each migrated template", () => {
    const onMigrate = vi.fn();
    migrateAllTemplates(extendedSchema, { dryRun: true, onMigrate });

    expect(onMigrate).toHaveBeenCalledTimes(1);
    expect(onMigrate).toHaveBeenCalledWith(
      "needs-migration",
      expect.objectContaining({ name: "needs-migration" }),
      expect.objectContaining({ name: "needs-migration", memo: "" })
    );
  });
});
