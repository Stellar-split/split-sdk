import type { InvoiceTemplate } from "./types.js";
import {
  loadTemplate,
  saveTemplate,
  listTemplates,
} from "./templateManager.js";

export interface TemplateDiffField {
  field: string;
  from: unknown;
  to: unknown;
}

export interface TemplateDiff {
  added: TemplateDiffField[];
  removed: TemplateDiffField[];
  changed: TemplateDiffField[];
}

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null;
}

function getAllKeys(template: InvoiceTemplate): string[] {
  return Object.keys(template) as (keyof InvoiceTemplate)[];
}

export function diffTemplate(
  existing: InvoiceTemplate,
  schema: InvoiceTemplate
): TemplateDiff {
  const added: TemplateDiffField[] = [];
  const removed: TemplateDiffField[] = [];
  const changed: TemplateDiffField[] = [];

  const existingKeys = new Set(getAllKeys(existing));
  const schemaKeys = new Set(getAllKeys(schema));

  for (const key of schemaKeys) {
    if (!existingKeys.has(key)) {
      added.push({
        field: key,
        from: undefined,
        to: (schema as Record<string, unknown>)[key],
      });
    } else {
      const existingVal = (existing as Record<string, unknown>)[key];
      const schemaVal = (schema as Record<string, unknown>)[key];
      if (
        isObject(existingVal) &&
        isObject(schemaVal) &&
        JSON.stringify(existingVal) !== JSON.stringify(schemaVal)
      ) {
        changed.push({ field: key, from: existingVal, to: schemaVal });
      } else if (
        !isObject(existingVal) &&
        !isObject(schemaVal) &&
        existingVal !== schemaVal
      ) {
        changed.push({ field: key, from: existingVal, to: schemaVal });
      }
    }
  }

  for (const key of existingKeys) {
    if (!schemaKeys.has(key)) {
      removed.push({
        field: key,
        from: (existing as Record<string, unknown>)[key],
        to: undefined,
      });
    }
  }

  return { added, removed, changed };
}

export function migrateTemplate(
  existing: InvoiceTemplate,
  schema: InvoiceTemplate
): InvoiceTemplate {
  const schemaKeys = getAllKeys(schema);
  const migrated = { ...existing } as Record<string, unknown>;

  for (const key of schemaKeys) {
    if (migrated[key] === undefined) {
      migrated[key] = (schema as Record<string, unknown>)[key];
    }
  }

  return migrated as unknown as InvoiceTemplate;
}

export function migrateAllTemplates(
  schema: InvoiceTemplate,
  options?: { dryRun?: boolean; onMigrate?: (name: string, before: InvoiceTemplate, after: InvoiceTemplate) => void }
): { migrated: number; skipped: number; errors: string[] } {
  const names = listTemplates();
  let migrated = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const name of names) {
    try {
      const existing = loadTemplate(name);
      if (!existing) {
        skipped++;
        continue;
      }

      const diff = diffTemplate(existing, schema);
      if (diff.added.length === 0 && diff.changed.length === 0) {
        skipped++;
        continue;
      }

      const updated = migrateTemplate(existing, schema);
      options?.onMigrate?.(name, existing, updated);

      if (!options?.dryRun) {
        saveTemplate(name, updated);
      }

      migrated++;
    } catch (error) {
      errors.push(
        `Failed to migrate template "${name}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return { migrated, skipped, errors };
}
