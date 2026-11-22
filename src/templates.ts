/**
 * Invoice template management — save, create, delete, get, list templates.
 */

import type {
  InvoiceTemplate,
  CreateFromTemplateParams,
  SaveTemplateParams,
  SerializedTemplate,
  TemplateUsage,
} from "./types/templates.js";
import type { CreateInvoiceParams } from "./types.js";
import { StellarSplitError } from "./errors.js";

export class TemplateNotFoundError extends StellarSplitError {
  readonly templateId: bigint;

  constructor(templateId: bigint) {
    super(
      `Template not found: ${templateId}`,
      "TEMPLATE_NOT_FOUND",
      { templateId }
    );
    this.name = "TemplateNotFoundError";
    this.templateId = templateId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class TemplateAccessDeniedError extends StellarSplitError {
  readonly templateId: bigint;

  constructor(templateId: bigint) {
    super(
      `Not authorized to delete template: ${templateId}`,
      "TEMPLATE_ACCESS_DENIED",
      { templateId }
    );
    this.name = "TemplateAccessDeniedError";
    this.templateId = templateId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const templates = new Map<bigint, InvoiceTemplate>();
const usage = new Map<bigint, TemplateUsage>();
let nextTemplateId = BigInt(1);

function getUsageRecord(templateId: bigint): TemplateUsage {
  let record = usage.get(templateId);
  if (!record) {
    record = { templateId, count: 0, lastUsedAt: 0 };
    usage.set(templateId, record);
  }
  return record;
}

export async function saveTemplate(
  params: SaveTemplateParams,
  creator: string
): Promise<bigint> {
  const templateId = nextTemplateId++;

  const template: InvoiceTemplate = {
    id: templateId,
    name: params.name,
    params: params.params,
    createdAt: Date.now(),
    creator,
    shared: params.shared ?? false,
  };

  templates.set(templateId, template);
  getUsageRecord(templateId);
  return templateId;
}

export async function createFromTemplate(
  params: CreateFromTemplateParams,
  creator: string
): Promise<bigint> {
  const template = templates.get(params.templateId);
  if (!template) {
    throw new TemplateNotFoundError(params.templateId);
  }

  // Merge template params with overrides
  const mergedParams = {
    ...template.params,
    ...(params.overrides || {}),
  };

  // In a real implementation, this would invoke the contract
  // to create an invoice with the merged params and return the invoice ID
  const invoiceId = BigInt(Date.now());

  // Track usage
  const record = getUsageRecord(params.templateId);
  record.count += 1;
  record.lastUsedAt = Date.now();

  return invoiceId;
}

export async function updateTemplate(
  templateId: bigint,
  updates: Partial<SaveTemplateParams>,
  creator: string
): Promise<InvoiceTemplate> {
  const template = templates.get(templateId);
  if (!template) {
    throw new TemplateNotFoundError(templateId);
  }

  if (template.creator !== creator) {
    throw new TemplateAccessDeniedError(templateId);
  }

  if (updates.name !== undefined) {
    template.name = updates.name;
  }
  if (updates.params !== undefined) {
    template.params = { ...template.params, ...updates.params };
  }
  if (updates.shared !== undefined) {
    template.shared = updates.shared;
  }

  templates.set(templateId, template);
  return template;
}

export async function setTemplateSharing(
  templateId: bigint,
  shared: boolean,
  creator: string
): Promise<InvoiceTemplate> {
  return updateTemplate(templateId, { shared }, creator);
}

export async function exportTemplate(
  templateId: bigint
): Promise<SerializedTemplate> {
  const template = templates.get(templateId);
  if (!template) {
    throw new TemplateNotFoundError(templateId);
  }

  return {
    name: template.name,
    params: { ...template.params },
    shared: template.shared ?? false,
    version: 1,
  };
}

export async function importTemplate(
  serialized: SerializedTemplate,
  creator: string
): Promise<bigint> {
  if (!serialized || typeof serialized.name !== "string" || !serialized.params) {
    throw new StellarSplitError(
      "Invalid serialized template",
      "TEMPLATE_INVALID",
      {}
    );
  }

  return saveTemplate(
    {
      name: serialized.name,
      params: serialized.params,
      shared: serialized.shared ?? false,
    },
    creator
  );
}

export async function getTemplateUsage(
  templateId: bigint
): Promise<TemplateUsage> {
  if (!templates.has(templateId)) {
    throw new TemplateNotFoundError(templateId);
  }
  return { ...getUsageRecord(templateId) };
}

export async function deleteTemplate(
  templateId: bigint,
  creator: string
): Promise<void> {
  const template = templates.get(templateId);
  if (!template) {
    throw new TemplateNotFoundError(templateId);
  }

  if (template.creator !== creator) {
    throw new TemplateAccessDeniedError(templateId);
  }

  templates.delete(templateId);
}

export async function getTemplate(templateId: bigint): Promise<InvoiceTemplate> {
  const template = templates.get(templateId);
  if (!template) {
    throw new TemplateNotFoundError(templateId);
  }
  return template;
}

export async function listTemplates(creator: string): Promise<InvoiceTemplate[]> {
  const creatorTemplates: InvoiceTemplate[] = [];

  for (const template of templates.values()) {
    if (template.creator === creator) {
      creatorTemplates.push(template);
    }
  }

  return creatorTemplates.sort((a, b) => b.createdAt - a.createdAt);
}

export async function listSharedTemplates(): Promise<InvoiceTemplate[]> {
  const sharedTemplates: InvoiceTemplate[] = [];

  for (const template of templates.values()) {
    if (template.shared) {
      sharedTemplates.push(template);
    }
  }

  return sharedTemplates.sort((a, b) => b.createdAt - a.createdAt);
}
