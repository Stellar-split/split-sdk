export type WebhookEvent = "payment" | "released" | "refunded";

export type WebhookConfig = {
  url: string;
  events: WebhookEvent[];
};

const webhookConfigs = new Map<string, WebhookConfig>();

export function registerWebhook(
  invoiceId: string,
  url: string,
  events: WebhookEvent[],
): void {
  webhookConfigs.set(invoiceId, { url, events });
}

export async function triggerWebhook(
  invoiceId: string,
  event: WebhookEvent,
  data: unknown,
): Promise<void> {
  const config = webhookConfigs.get(invoiceId);
  if (!config || !config.events.includes(event)) {
    return;
  }

  const payload = {
    invoiceId,
    event,
    timestamp: new Date().toISOString(),
    data,
  };

  await fetch(config.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}
