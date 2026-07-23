import { describe, it, expect } from "vitest";
import { FallbackChain, FallbackExhaustedError } from "../src/index.ts";

describe("FallbackChain", () => {
  it("tries each RPC URL in order and logs every failure", async () => {
    const urls = ["https://first.example", "https://second.example"];
    const logs: Array<{ url: string; error: string; attemptMs: number }> = [];
    const chain = new FallbackChain(urls, {
      logger: (attempt) => logs.push(attempt),
    });

    const operation = async (url: string): Promise<string> => {
      throw new Error(`request failed for ${url}`);
    };

    const promise = chain.execute(operation);

    await expect(promise).rejects.toBeInstanceOf(FallbackExhaustedError);

    expect(logs).toHaveLength(2);
    expect(logs[0]!.url).toBe(urls[0]);
    expect(logs[1]!.url).toBe(urls[1]);
    expect(logs[0]!.error).toContain("request failed for https://first.example");
    expect(logs[1]!.error).toContain("request failed for https://second.example");
    expect(logs[0]!.attemptMs).toBeGreaterThanOrEqual(0);
    expect(logs[1]!.attemptMs).toBeGreaterThanOrEqual(0);

    await promise.catch((error) => {
      expect(error).toBeInstanceOf(FallbackExhaustedError);
      if (error instanceof FallbackExhaustedError) {
        expect(error.attempts).toEqual(logs);
      }
    });
  });

  it("returns a successful response from the first available URL", async () => {
    const urls = ["https://primary.example", "https://backup.example"];
    const chain = new FallbackChain(urls);

    const result = await chain.execute(async (url) => {
      if (url === urls[0]) return "success";
      throw new Error("should not attempt backup");
    });

    expect(result).toBe("success");
  });
});
