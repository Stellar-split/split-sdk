/**
 * Invoice template types for template-based invoice creation.
 */

import type { CreateInvoiceParams, Recipient } from "../types.js";

/**
 * Definition of a customizable template parameter.
 *
 * Parameters allow a template to be reused with different values
 * without redefining the whole invoice. Each parameter maps to a
 * field in {@link CreateInvoiceParams} (or a nested path) and may
 * declare a default value, whether it is required, and a description.
 */
export interface TemplateParameter {
  /** Unique key identifying the parameter within a template. */
  key: string;
  /** Human-readable label for the parameter. */
  label?: string;
  /** Description of what the parameter controls. */
  description?: string;
  /** Dot-path into {@link CreateInvoiceParams} this parameter populates. */
  path?: string;
  /** Default value applied when no override is supplied. */
  defaultValue?: unknown;
  /** Whether the parameter must be supplied when creating an invoice. */
  required?: boolean;
  /** Optional value type hint for validation/UI rendering. */
  type?: "string" | "number" | "bigint" | "boolean" | "address" | "recipient" | "json";
}

/**
 * Customization overrides applied on top of a template's base params.
 *
 * Supports both a shallow set of {@link CreateInvoiceParams} overrides
 * and parameter-key based values resolved via {@link TemplateParameter}.
 */
export interface TemplateCustomization {
  /** Direct overrides merged into the template's base params. */
  overrides?: Partial<CreateInvoiceParams>;
  /** Parameter values keyed by {@link TemplateParameter.key}. */
  parameters?: Record<string, unknown>;
}

/**
 * Sharing metadata for a template.
 *
 * A template can be shared either by reference (share token) or by
 * exporting a serialized, self-contained form that can be imported
 * by another party.
 */
export interface TemplateSharing {
  /** Opaque token that can be used to share/import the template. */
  shareToken?: string;
  /** Serialized, self-contained representation of the template. */
  serialized?: string;
  /** Whether the template is publicly shareable. */
  isPublic?: boolean;
  /** Addresses the template has been shared with. */
  sharedWith?: string[];
  /** Timestamp (ms) when the template was shared. */
  sharedAt?: number;
}

/**
 * Usage tracking metadata for a template.
 */
export interface TemplateUsage {
  /** Number of times the template has been used to create invoices. */
  usageCount: number;
  /** Timestamp (ms) of the most recent use, if any. */
  lastUsedAt?: number;
}

export interface InvoiceTemplate {
  id: bigint;
  name: string;
  params: CreateInvoiceParams;
  createdAt: number;
  creator: string;
  /** Optional description of the template's purpose. */
  description?: string;
  /** Optional category used to group templates. */
  category?: string;
  /** Customizable parameter definitions. */
  parameters?: TemplateParameter[];
  /** Default customization applied when using the template. */
  customization?: TemplateCustomization;
  /** Sharing metadata. */
  sharing?: TemplateSharing;
  /** Usage counters. */
  usageCount?: number;
  /** Timestamp (ms) of the most recent use. */
  lastUsedAt?: number;
}

export interface CreateFromTemplateParams {
  templateId: bigint;
  overrides?: Partial<CreateInvoiceParams>;
  /** Parameter values keyed by {@link TemplateParameter.key}. */
  parameters?: Record<string, unknown>;
  /** Full customization object (overrides + parameters). */
  customization?: TemplateCustomization;
}

export interface SaveTemplateParams {
  name: string;
  params: CreateInvoiceParams;
  /** Optional description of the template's purpose. */
  description?: string;
  /** Optional category used to group templates. */
  category?: string;
  /** Customizable parameter definitions. */
  parameters?: TemplateParameter[];
  /** Default customization applied when using the template. */
  customization?: TemplateCustomization;
  /** Sharing metadata to persist with the template. */
  sharing?: TemplateSharing;
}

/**
 * Parameters for importing a shared template.
 */
export interface ImportTemplateParams {
  /** Serialized template form produced by sharing. */
  serialized?: string;
  /** Share token referencing a shared template. */
  shareToken?: string;
  /** Optional name override for the imported template. */
  name?: string;
}

/**
 * Result of resolving a template into concrete invoice params.
 */
export interface ResolvedTemplate {
  /** The template that was resolved. */
  template: InvoiceTemplate;
  /** The final params after applying customization. */
  params: CreateInvoiceParams;
  /** Parameter values that were applied. */
  appliedParameters?: Record<string, unknown>;
}