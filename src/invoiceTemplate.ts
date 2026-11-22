/**
 * Serializer / deserializer for invoice templates.
 *
 * Versioned JSON format { v: 1, data: { ... } } with bigint fields
 * serialized as strings to avoid JSON precision loss.
 */

import type { CreateInvoiceParams, Recipient } from "./types.js";
import { ValidationError } from "./errors.js";

interface SerializedRecipient {
  address: string;
  amount: string;
}

/**
 * Customization options applied on top of a template's base parameters.
 * All fields are optional; absent fields fall back to the template defaults.
 */
export interface TemplateCustomization {
  /** Override the invoice title / memo shown to recipients. */
  title?: string;
  /** Override the invoice description. */
  description?: string;
  /** Arbitrary key/value metadata attached to the invoice. */
  metadata?: Record<string, string>;
  /** Optional accent color (e.g. "#4f46e5") used by renderers. */
  accentColor?: string;
}

/**
 * Metadata describing how a template is shared and how often it is used.
 */
export interface TemplateSharing {
  /** Whether the template is publicly shareable. */
  shared: boolean;
  /** Optional share identifier / slug used in share links. */
  shareId?: string;
  /** Optional list of addresses the template has been shared with. */
  sharedWith?: string[];
}

export interface TemplateUsage {
  /** Number of times the template has been used to create an invoice. */
  useCount: number;
  /** Unix timestamp (ms) of the last use, or null if never used. */
  lastUsedAt: number | null;
}

/**
 * Template parameters: the base invoice parameters a template produces.
 * Identical in shape to CreateInvoiceParams.
 */
export type TemplateParameters = CreateInvoiceParams;

interface TemplateData {
  creator: string;
  recipients: SerializedRecipient[];
  token: string;
  deadline: number;
  parameters?: {
    creator: string;
    recipients: SerializedRecipient[];
    token: string;
    deadline: number;
  };
  customization?: TemplateCustomization;
  sharing?: TemplateSharing;
  usage?: TemplateUsage;
}

interface SerializedTemplate {
  v: 1;
  data: TemplateData;
}

/**
 * Full template payload accepted by the serializer. The legacy flat fields
 * (creator/recipients/token/deadline) are always derived from `parameters`
 * when present so old readers keep working.
 */
export interface InvoiceTemplateInput extends CreateInvoiceParams {
  parameters?: TemplateParameters;
  customization?: TemplateCustomization;
  sharing?: TemplateSharing;
  usage?: TemplateUsage;
}

function serializeRecipients(recipients: Recipient[]): SerializedRecipient[] {
  return recipients.map((r) => ({
    address: r.address,
    amount: r.amount.toString(),
  }));
}

function deserializeRecipients(
  recipients: SerializedRecipient[],
  fieldPrefix: string,
): Recipient[] {
  return recipients.map((r, i) => {
    if (typeof r.address !== "string" || r.address.length === 0) {
      throw new ValidationError(`${fieldPrefix}[${i}].address is invalid`);
    }
    if (typeof r.amount !== "string" || !/^\d+$/.test(r.amount)) {
      throw new ValidationError(
        `${fieldPrefix}[${i}].amount must be a decimal string`,
      );
    }
    return { address: r.address, amount: BigInt(r.amount) };
  });
}

function validateCustomization(
  customization: unknown,
): TemplateCustomization | undefined {
  if (customization === undefined) return undefined;
  if (typeof customization !== "object" || customization === null) {
    throw new ValidationError("'customization' must be an object");
  }
  const c = customization as Record<string, unknown>;
  if (c.title !== undefined && typeof c.title !== "string") {
    throw new ValidationError("'customization.title' must be a string");
  }
  if (c.description !== undefined && typeof c.description !== "string") {
    throw new ValidationError("'customization.description' must be a string");
  }
  if (c.accentColor !== undefined && typeof c.accentColor !== "string") {
    throw new ValidationError("'customization.accentColor' must be a string");
  }
  if (c.metadata !== undefined) {
    if (typeof c.metadata !== "object" || c.metadata === null) {
      throw new ValidationError("'customization.metadata' must be an object");
    }
    for (const [k, v] of Object.entries(c.metadata as Record<string, unknown>)) {
      if (typeof v !== "string") {
        throw new ValidationError(
          `'customization.metadata.${k}' must be a string`,
        );
      }
    }
  }
  return customization as TemplateCustomization;
}

function validateSharing(sharing: unknown): TemplateSharing | undefined {
  if (sharing === undefined) return undefined;
  if (typeof sharing !== "object" || sharing === null) {
    throw new ValidationError("'sharing' must be an object");
  }
  const s = sharing as Record<string, unknown>;
  if (typeof s.shared !== "boolean") {
    throw new ValidationError("'sharing.shared' must be a boolean");
  }
  if (s.shareId !== undefined && typeof s.shareId !== "string") {
    throw new ValidationError("'sharing.shareId' must be a string");
  }
  if (s.sharedWith !== undefined) {
    if (!Array.isArray(s.sharedWith)) {
      throw new ValidationError("'sharing.sharedWith' must be an array");
    }
    for (const [i, addr] of s.sharedWith.entries()) {
      if (typeof addr !== "string" || addr.length === 0) {
        throw new ValidationError(`'sharing.sharedWith[${i}]' is invalid`);
      }
    }
  }
  return sharing as TemplateSharing;
}

function validateUsage(usage: unknown): TemplateUsage | undefined {
  if (usage === undefined) return undefined;
  if (typeof usage !== "object" || usage === null) {
    throw new ValidationError("'usage' must be an object");
  }
  const u = usage as Record<string, unknown>;
  if (
    typeof u.useCount !== "number" ||
    !Number.isFinite(u.useCount) ||
    u.useCount < 0
  ) {
    throw new ValidationError("'usage.useCount' must be a non-negative number");
  }
  if (
    u.lastUsedAt !== null &&
    (typeof u.lastUsedAt !== "number" || !Number.isFinite(u.lastUsedAt))
  ) {
    throw new ValidationError("'usage.lastUsedAt' must be a number or null");
  }
  return usage as TemplateUsage;
}

/**
 * Serialize a CreateInvoiceParams into a versioned JSON string.
 * bigint `amount` fields are stored as decimal strings.
 */
export function serializeInvoiceTemplate(
  params: InvoiceTemplateInput,
): string {
  const base = params.parameters ?? params;
  const data: TemplateData = {
    creator: base.creator,
    recipients: serializeRecipients(base.recipients),
    token: base.token,
    deadline: base.deadline,
  };
  if (params.parameters !== undefined) {
    data.parameters = {
      creator: params.parameters.creator,
      recipients: serializeRecipients(params.parameters.recipients),
      token: params.parameters.token,
      deadline: params.parameters.deadline,
    };
  }
  if (params.customization !== undefined) {
    data.customization = params.customization;
  }
  if (params.sharing !== undefined) {
    data.sharing = params.sharing;
  }
  if (params.usage !== undefined) {
    data.usage = params.usage;
  }
  const envelope: SerializedTemplate = { v: 1, data };
  return JSON.stringify(envelope);
}

/**
 * Deserialize a JSON string produced by serializeInvoiceTemplate.
 * Throws ValidationError if the payload is malformed.
 */
export function deserializeInvoiceTemplate(json: string): InvoiceTemplateInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ValidationError("Invalid JSON");
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Record<string, unknown>).v !== 1
  ) {
    throw new ValidationError("Missing or unsupported version field 'v'", { field: "v", value: (parsed as Record<string, unknown>)?.v });
  }

  const { data } = parsed as SerializedTemplate;

  if (typeof data !== "object" || data === null) {
    throw new ValidationError("Missing 'data' field");
  }
  if (typeof data.creator !== "string" || data.creator.length === 0) {
    throw new ValidationError("Invalid or missing 'creator'");
  }
  if (!Array.isArray(data.recipients)) {
    throw new ValidationError("'recipients' must be an array");
  }
  if (typeof data.token !== "string" || data.token.length === 0) {
    throw new ValidationError("Invalid or missing 'token'");
  }
  if (typeof data.deadline !== "number" || !Number.isFinite(data.deadline)) {
    throw new ValidationError("Invalid or missing 'deadline'");
  }

  const recipients: Recipient[] = deserializeRecipients(
    data.recipients,
    "recipients",
  );

  const result: InvoiceTemplateInput = {
    creator: data.creator,
    recipients,
    token: data.token,
    deadline: data.deadline,
  };

  if (data.parameters !== undefined) {
    const p = data.parameters;
    if (typeof p !== "object" || p === null) {
      throw new ValidationError("'parameters' must be an object");
    }
    if (typeof p.creator !== "string" || p.creator.length === 0) {
      throw new ValidationError("Invalid or missing 'parameters.creator'");
    }
    if (!Array.isArray(p.recipients)) {
      throw new ValidationError("'parameters.recipients' must be an array");
    }
    if (typeof p.token !== "string" || p.token.length === 0) {
      throw new ValidationError("Invalid or missing 'parameters.token'");
    }
    if (typeof p.deadline !== "number" || !Number.isFinite(p.deadline)) {
      throw new ValidationError("Invalid or missing 'parameters.deadline'");
    }
    result.parameters = {
      creator: p.creator,
      recipients: deserializeRecipients(
        p.recipients,
        "parameters.recipients",
      ),
      token: p.token,
      deadline: p.deadline,
    };
  }

  const customization = validateCustomization(data.customization);
  if (customization !== undefined) result.customization = customization;

  const sharing = validateSharing(data.sharing);
  if (sharing !== undefined) result.sharing = sharing;

  const usage = validateUsage(data.usage);
  if (usage !== undefined) result.usage = usage;

  return result;
}
