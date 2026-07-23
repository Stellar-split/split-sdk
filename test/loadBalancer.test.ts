import { describe, expect, it } from "vitest";
import { LoadBalancer } from "../src/loadBalancer.js";

describe("LoadBalancer", () => {
  it("routes requests to the lowest-latency healthy endpoint", () => {
    const balancer = new LoadBalancer(["https://slow.example", "https://fast.example"]);
    balancer.recordSuccess("https://slow.example", 200);
    balancer.recordSuccess("https://fast.example", 20);

    const counts = new Map<string, number>();
    for (let i = 0; i < 20; i++) {
      const endpoint = balancer.selectEndpoint();
      counts.set(endpoint, (counts.get(endpoint) ?? 0) + 1);
    }

    expect(counts.get("https://fast.example")).toBe(20);
    expect(counts.get("https://slow.example") ?? 0).toBe(0);
  });

  it("marks endpoints unhealthy after failures and re-probes after 30 seconds", () => {
    let now = 1_000;
    const balancer = new LoadBalancer(["https://a.example", "https://b.example"], {
      now: () => now,
    });

    balancer.recordFailure("https://a.example");
    balancer.recordFailure("https://a.example");
    balancer.recordFailure("https://a.example");

    expect(balancer.getEndpointState("https://a.example").healthy).toBe(false);
    expect(balancer.selectEndpoint()).toBe("https://b.example");

    now += 30_000;

    const selections = new Set([balancer.selectEndpoint(), balancer.selectEndpoint()]);
    expect(selections.has("https://a.example")).toBe(true);
  });
});
