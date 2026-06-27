import type { InvoiceTemplate } from "./types.js";
import {
  loadTemplate,
  saveTemplate,
  listTemplates,
} from "./templateManager.js";

const safeStringify = (val: unknown) => JSON.stringify(val, (_, v) => (typeof v === "bigint" ? v.toString() : v));

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

/**
 * Compare two templates and produce a structured field-level diff.
 *
 * @param existing - The current template
 * @param schema - The target template schema
 * @returns A diff containing added, removed, and changed fields
 */
export function diffTemplate(
  existing: InvoiceTemplate,
  schema: InvoiceTemplate
): TemplateDiff {
  const added: TemplateDiffField[] = [];
  const removed: TemplateDiffField[] = [];
  const changed: TemplateDiffField[] = [];

  const existingKeys = new Set(Object.keys(existing));
  const schemaKeys = new Set(Object.keys(schema));

  for (const key of schemaKeys) {
    if (!existingKeys.has(key)) {
      added.push({
        field: key,
        from: undefined,
        to: (schema as unknown as Record<string, unknown>)[key],
      });
    } else {
      const existingVal = (existing as unknown as Record<string, unknown>)[key];
      const schemaVal = (schema as unknown as Record<string, unknown>)[key];
      if (
        isObject(existingVal) &&
        isObject(schemaVal) &&
        safeStringify(existingVal) !== safeStringify(schemaVal)
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
        from: (existing as unknown as Record<string, unknown>)[key],
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
  const schemaKeys = Object.keys(schema);
  const migrated = { ...existing } as Record<string, unknown>;

  for (const key of schemaKeys) {
    if (migrated[key] === undefined) {
      migrated[key] = (schema as unknown as Record<string, unknown>)[key];
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
      if (diff.added.length === 0) {
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
