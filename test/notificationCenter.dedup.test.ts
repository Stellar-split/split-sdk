import { describe, it, expect, vi } from "vitest";
import { NotificationCenter } from "../src/notificationCenter.js";

describe("NotificationCenter subscriber deduplication", () => {
  it("registers the same callback reference only once for the same event", () => {
    const center = new NotificationCenter(async () => {
      throw new Error("not used in this test");
    });
    const handler = vi.fn();

    center.on("payment", handler);
    center.on("payment", handler);
    center.on("payment", handler);

    expect(center.getSubscriberCount("payment")).toBe(1);

    center.emit("payment", "invoice-1", { payer: "G...", amount: 1n });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("registers different callback references independently", () => {
    const center = new NotificationCenter(async () => {
      throw new Error("not used in this test");
    });
    const handlerA = vi.fn();
    const handlerB = vi.fn();

    center.on("payment", handlerA);
    center.on("payment", handlerB);

    expect(center.getSubscriberCount("payment")).toBe(2);
  });

  it("tracks subscriber counts independently per event type", () => {
    const center = new NotificationCenter(async () => {
      throw new Error("not used in this test");
    });
    const handler = vi.fn();

    center.on("payment", handler);
    center.on("released", handler);

    expect(center.getSubscriberCount("payment")).toBe(1);
    expect(center.getSubscriberCount("released")).toBe(1);
    expect(center.getSubscriberCount("expired")).toBe(0);
  });
});
