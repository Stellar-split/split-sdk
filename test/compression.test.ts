import { describe, expect, it } from "vitest";
import {
  compressPayload,
  createCompressionRequestInterceptor,
  decompressPayload,
} from "../src/compression.js";

describe("compression middleware", () => {
  it("compresses payloads smaller than the original and decompresses them", async () => {
    const original = "invoice-response:".repeat(200);
    const compressed = await compressPayload(original, "gzip");
    const decompressed = await decompressPayload(compressed);
    const decoded = new TextDecoder().decode(decompressed);

    expect(compressed.body.byteLength).toBeLessThan(new TextEncoder().encode(original).byteLength);
    expect(decoded).toBe(original);
  });

  it("leaves small request bodies unchanged and compresses bodies over 1KB when enabled", async () => {
    const interceptor = createCompressionRequestInterceptor({
      enabled: true,
      algorithm: "gzip",
    });
    const large = "x".repeat(2_048);

    const smallResult = await interceptor({ method: "test", params: ["small"] });
    const largeResult = await interceptor({ method: "test", params: [large] });

    expect(smallResult.params[0]).toBe("small");
    expect(largeResult.params[0]).toMatchObject({ compressed: true, algorithm: "gzip" });
  });
});
