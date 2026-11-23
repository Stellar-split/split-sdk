import { describe, it, expect } from "vitest";
import { SdkStreamRegistry } from "../src/sdkStreamingApi.js";

describe("sdkStreamingApi", () => {
  it("delivers chunks in order and tracks stats", async () => {
    const reg = new SdkStreamRegistry();
    const s = reg.create<number>();
    s.push(1);
    s.push(2);
    s.close();
    const out: number[] = [];
    for await (const c of s) out.push(c);
    expect(out).toEqual([1, 2]);
    expect(s.stats()).toMatchObject({ chunksReceived: 2, chunksDelivered: 2, closed: true });
    expect(reg.stats()).toHaveLength(1);
  });

  it("applies backpressure until consumer drains", async () => {
    const s = new SdkStreamRegistry().create<number>({ highWaterMark: 2 });
    expect(s.push(1)).toBe(true);
    expect(s.push(2)).toBe(false);
    expect(s.stats().paused).toBe(true);
    let drained = false;
    const p = s.drain().then(() => (drained = true));
    await Promise.resolve();
    expect(drained).toBe(false);
    await s[Symbol.asyncIterator]().next();
    await p;
    expect(drained).toBe(true);
  });
});
