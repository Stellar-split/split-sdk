import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  RingBufferStore,
  recordWebhookEvent,
  replayWebhook,
  configureReplayStore,
} from "../src/webhookReplay.js";

function makeFetch(responses: Record<string, object> = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    return {
      ok: true,
      json: async () => responses[url] ?? {},
      body: init?.body,
    } as Response;
  });
}

beforeEach(() => {
  configureReplayStore(new RingBufferStore(50));
});

describe("RingBufferStore", () => {
  it("stores and retrieves records", () => {
    const store = new RingBufferStore(10);
    const record = {
      eventId: "e1",
      invoiceId: "inv1",
      event: "payment" as const,
      url: "https://example.com/hook",
      payload: { foo: 1 },
      firedAt: new Date().toISOString(),
    };
    store.set("e1", record);
    expect(store.get("e1")).toEqual(record);
  });

  it("evicts oldest entry when at capacity", () => {
    const store = new RingBufferStore(2);
    const makeRec = (id: string) => ({
      eventId: id,
      invoiceId: "inv",
      event: "payment" as const,
      url: "https://example.com",
      payload: {},
      firedAt: new Date().toISOString(),
    });
    store.set("a", makeRec("a"));
    store.set("b", makeRec("b"));
    store.set("c", makeRec("c")); // should evict "a"
    expect(store.get("a")).toBeUndefined();
    expect(store.get("b")).toBeDefined();
    expect(store.get("c")).toBeDefined();
    expect(store.size).toBe(2);
  });

  it("does not grow beyond max size", () => {
    const store = new RingBufferStore(3);
    for (let i = 0; i < 10; i++) {
      store.set(`e${i}`, {
        eventId: `e${i}`,
        invoiceId: "inv",
        event: "payment" as const,
        url: "https://example.com",
        payload: {},
        firedAt: new Date().toISOString(),
      });
    }
    expect(store.size).toBe(3);
  });
});

describe("recordWebhookEvent + replayWebhook", () => {
  it("replay sends identical payload to the original", async () => {
    const fetchSpy = makeFetch();
    vi.stubGlobal("fetch", fetchSpy);

    const payload = { invoiceId: "inv1", event: "payment", data: { amount: 42 } };
    const eventId = recordWebhookEvent("inv1", "payment", "https://hook.test/cb", payload);

    await replayWebhook(eventId);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://hook.test/cb");
    expect(JSON.parse(init!.body as string)).toEqual(payload);

    vi.unstubAllGlobals();
  });

  it("throws when replaying an unknown event ID", async () => {
    await expect(replayWebhook("nonexistent-id")).rejects.toThrow(
      "Webhook event not found: nonexistent-id",
    );
  });
});
