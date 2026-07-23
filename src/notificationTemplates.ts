export type InvoiceEventType = "created" | "payment" | "released" | "refunded" | "expiring";

export interface InvoiceEvent {
  type: InvoiceEventType;
  invoiceId: string;
  amount?: bigint | number | string;
  creator?: string;
}

export const builtInNotificationTemplates: Record<InvoiceEventType, string> = {
  created: "Invoice {{invoiceId}} was created by {{creator}} for {{amount}}.",
  payment: "Payment of {{amount}} received for invoice {{invoiceId}}.",
  released: "Invoice {{invoiceId}} has been released to recipients.",
  refunded: "Invoice {{invoiceId}} has been refunded by {{creator}}.",
  expiring: "Invoice {{invoiceId}} for {{amount}} is expiring soon.",
};

const VARIABLE_PATTERN = /\{\{\s*(invoiceId|amount|creator)\s*\}\}/g;

function stringifyTemplateValue(value: bigint | number | string | undefined): string {
  return value === undefined ? "" : value.toString();
}

export function renderTemplate(event: InvoiceEvent, template?: string): string {
  const source = template ?? builtInNotificationTemplates[event.type];
  const values: Record<"invoiceId" | "amount" | "creator", string> = {
    invoiceId: event.invoiceId,
    amount: stringifyTemplateValue(event.amount),
    creator: stringifyTemplateValue(event.creator),
  };

  return source.replace(VARIABLE_PATTERN, (_match, key: string) => {
    return values[key as keyof typeof values];
  });
}
