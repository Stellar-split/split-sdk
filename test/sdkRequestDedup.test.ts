import { describe, it, expect, vi } from "vitest";
import { SdkRequestDedup } from "../src/sdkRequestDedup.js";

describe("SdkRequestDedup", () => {
  it("dedupes within ttl and tracks stats", async () => {
    let t = 0;
    const d = new SdkRequestDedup(100, () => t);
    const fn = vi.fn(async () => "x");
    await Promise.all([d.run("k", fn), d.run("k", fn)]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(d.stats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it("enforces expiry", async () => {
    let t = 0;
    const d = new SdkRequestDedup(100, () => t);
    const fn = vi.fn(async () => "x");
    await d.run("k", fn);
    t = 101;
    await d.run("k", fn);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(d.stats().expired).toBe(1);
  });

  it("does not cache failures", async () => {
    const d = new SdkRequestDedup();
    await expect(d.run("k", async () => { throw new Error("no"); })).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(await d.run("k", async () => "ok")).toBe("ok");
  });
});
