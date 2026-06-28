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

interface TemplateData {
  creator: string;
  recipients: SerializedRecipient[];
  token: string;
  deadline: number;
}

interface SerializedTemplate {
  v: 1;
  data: TemplateData;
}

/**
 * Serialize a CreateInvoiceParams into a versioned JSON string.
 * bigint `amount` fields are stored as decimal strings.
 */
export function serializeInvoiceTemplate(params: CreateInvoiceParams): string {
  const data: TemplateData = {
    creator: params.creator,
    recipients: params.recipients.map((r) => ({
      address: r.address,
      amount: r.amount.toString(),
    })),
    token: params.token,
    deadline: params.deadline,
  };
  const envelope: SerializedTemplate = { v: 1, data };
  return JSON.stringify(envelope);
}

/**
 * Deserialize a JSON string produced by serializeInvoiceTemplate.
 * Throws ValidationError if the payload is malformed.
 */
export function deserializeInvoiceTemplate(json: string): CreateInvoiceParams {
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

  const recipients: Recipient[] = data.recipients.map((r, i) => {
    if (typeof r.address !== "string" || r.address.length === 0) {
      throw new ValidationError(`recipients[${i}].address is invalid`);
    }
    if (typeof r.amount !== "string" || !/^\d+$/.test(r.amount)) {
      throw new ValidationError(`recipients[${i}].amount must be a decimal string`);
    }
    return { address: r.address, amount: BigInt(r.amount) };
  });

  return {
    creator: data.creator,
    recipients,
    token: data.token,
    deadline: data.deadline,
  };
}
