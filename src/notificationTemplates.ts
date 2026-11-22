export type InvoiceEventType = "created" | "payment" | "released" | "refunded" | "expiring";

export type ReminderEventType = "reminder-due-soon" | "reminder-overdue";

export type NotificationEventType = InvoiceEventType | ReminderEventType;

export interface InvoiceEvent {
  type: InvoiceEventType;
  invoiceId: string;
  amount?: bigint | number | string;
  creator?: string;
}

export interface ReminderEvent {
  type: ReminderEventType;
  invoiceId: string;
  amount?: bigint | number | string;
  creator?: string;
  dueDate?: bigint | number | string | Date;
}

export type NotificationEvent = InvoiceEvent | ReminderEvent;

export const builtInNotificationTemplates: Record<InvoiceEventType, string> = {
  created: "Invoice {{invoiceId}} was created by {{creator}} for {{amount}}.",
  payment: "Payment of {{amount}} received for invoice {{invoiceId}}.",
  released: "Invoice {{invoiceId}} has been released to recipients.",
  refunded: "Invoice {{invoiceId}} has been refunded by {{creator}}.",
  expiring: "Invoice {{invoiceId}} for {{amount}} is expiring soon.",
};

export const builtInReminderTemplates: Record<ReminderEventType, string> = {
  "reminder-due-soon":
    "Reminder: Invoice {{invoiceId}} for {{amount}} is due soon on {{dueDate}}.",
  "reminder-overdue":
    "Reminder: Invoice {{invoiceId}} for {{amount}} is overdue (was due on {{dueDate}}).",
};

export const builtInNotificationTemplateRegistry: Record<NotificationEventType, string> = {
  ...builtInNotificationTemplates,
  ...builtInReminderTemplates,
};

const VARIABLE_PATTERN = /\{\{\s*(invoiceId|amount|creator|dueDate)\s*\}\}/g;

function stringifyTemplateValue(value: bigint | number | string | Date | undefined): string {
  if (value === undefined) {
    return "";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value.toString();
}

function isReminderEvent(event: NotificationEvent): event is ReminderEvent {
  return event.type === "reminder-due-soon" || event.type === "reminder-overdue";
}

export function renderTemplate(event: NotificationEvent, template?: string): string {
  const source =
    template ??
    builtInNotificationTemplateRegistry[event.type] ??
    builtInNotificationTemplates[event.type as InvoiceEventType];

  const values: Record<"invoiceId" | "amount" | "creator" | "dueDate", string> = {
    invoiceId: event.invoiceId,
    amount: stringifyTemplateValue(event.amount),
    creator: stringifyTemplateValue(event.creator),
    dueDate: stringifyTemplateValue(isReminderEvent(event) ? event.dueDate : undefined),
  };

  return source.replace(VARIABLE_PATTERN, (_match, key: string) => {
    return values[key as keyof typeof values];
  });
}