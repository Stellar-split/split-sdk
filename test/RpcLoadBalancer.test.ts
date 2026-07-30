import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RpcLoadBalancer } from "../src/rpc/RpcLoadBalancer.js";
import type { RpcEndpointServer } from "../src/rpc/RpcLoadBalancer.js";

/** A fake endpoint server whose getHealth() outcome is controlled by the test. */
function makeFakeServer(): RpcEndpointServer & { healthy: boolean } {
  const server = {
    healthy: true,
    async getHealth() {
      if (!server.healthy) {
        throw new Error("unhealthy");
      }
      return { status: "healthy" };
    },
  };
  return server;
}

function makeBalancer(
  configs: Array<{ url: string; weight?: number; maxLatencyMs?: number }>,
  opts: { now?: () => number; quarantineDurationMs?: number; healthCheckIntervalMs?: number } = {},
) {
  const servers = new Map<string, ReturnType<typeof makeFakeServer>>();
  const balancer = new RpcLoadBalancer(configs, {
    ...opts,
    serverFactory: (url) => {
      const server = makeFakeServer();
      servers.set(url, server);
      return server;
    },
  });
  return { balancer, servers };
}

describe("RpcLoadBalancer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("selects among healthy endpoints on initial calls", () => {
    const { balancer } = makeBalancer([{ url: "https://a" }, { url: "https://b" }]);
    const first = balancer.selectEndpoint();
    expect(["https://a", "https://b"]).toContain(first.url);
    expect(balancer.getEndpointStates().every((e) => e.status === "healthy")).toBe(true);
  });

  it("distributes calls proportionally to computed weight scores", () => {
    // Equal weight/latency budget -> equal score -> ~50/50 split over many picks.
    const { balancer } = makeBalancer([
      { url: "https://a", weight: 1 },
      { url: "https://b", weight: 1 },
    ]);

    const counts: Record<string, number> = { "https://a": 0, "https://b": 0 };
    for (let i = 0; i < 100; i++) {
      counts[balancer.selectEndpoint().url]!++;
    }
    expect(counts["https://a"]).toBe(50);
    expect(counts["https://b"]).toBe(50);
  });

  it("weights selection 2:1 when one endpoint has double the weight", () => {
    const { balancer } = makeBalancer([
      { url: "https://a", weight: 2 },
      { url: "https://b", weight: 1 },
    ]);

    const counts: Record<string, number> = { "https://a": 0, "https://b": 0 };
    for (let i = 0; i < 90; i++) {
      counts[balancer.selectEndpoint().url]!++;
    }
    expect(counts["https://a"]).toBe(60);
    expect(counts["https://b"]).toBe(30);
  });

  it("demotes an endpoint after 3 consecutive errors within the 60s window", () => {
    let now = 0;
    const { balancer } = makeBalancer(
      [{ url: "https://a" }, { url: "https://b" }],
      { now: () => now },
    );

    const demoted: string[] = [];
    balancer.on("endpoint:demoted", (e) => demoted.push(e.url));

    balancer.recordResult("https://a", { success: false, latencyMs: 10 });
    now += 1000;
    balancer.recordResult("https://a", { success: false, latencyMs: 10 });
    now += 1000;
    expect(demoted).toEqual([]);
    balancer.recordResult("https://a", { success: false, latencyMs: 10 });

    expect(demoted).toEqual(["https://a"]);
    expect(balancer.getEndpointStates().find((e) => e.url === "https://a")!.status).toBe(
      "quarantined",
    );

    // Demoted endpoint is skipped for subsequent selection.
    for (let i = 0; i < 10; i++) {
      expect(balancer.selectEndpoint().url).toBe("https://b");
    }
  });

  it("does not demote when a success resets the consecutive-error streak", () => {
    let now = 0;
    const { balancer } = makeBalancer([{ url: "https://a" }, { url: "https://b" }], {
      now: () => now,
    });
    const demoted: string[] = [];
    balancer.on("endpoint:demoted", (e) => demoted.push(e.url));

    balancer.recordResult("https://a", { success: false, latencyMs: 10 });
    balancer.recordResult("https://a", { success: true, latencyMs: 10 });
    balancer.recordResult("https://a", { success: false, latencyMs: 10 });
    balancer.recordResult("https://a", { success: false, latencyMs: 10 });

    expect(demoted).toEqual([]);
  });

  it("reinstates a demoted endpoint after quarantineDurationMs once its health check passes", async () => {
    let now = 0;
    const { balancer, servers } = makeBalancer(
      [{ url: "https://a" }, { url: "https://b" }],
      { now: () => now, quarantineDurationMs: 60_000 },
    );
    const reinstated: string[] = [];
    balancer.on("endpoint:reinstated", (e) => reinstated.push(e.url));

    balancer.recordResult("https://a", { success: false, latencyMs: 10 });
    balancer.recordResult("https://a", { success: false, latencyMs: 10 });
    balancer.recordResult("https://a", { success: false, latencyMs: 10 });
    expect(balancer.getEndpointStates().find((e) => e.url === "https://a")!.status).toBe(
      "quarantined",
    );

    // Not due yet.
    now += 30_000;
    await balancer.runHealthChecks();
    expect(reinstated).toEqual([]);

    // Quarantine elapsed and health check passes.
    now += 30_001;
    await balancer.runHealthChecks();
    expect(reinstated).toEqual(["https://a"]);
    expect(balancer.getEndpointStates().find((e) => e.url === "https://a")!.status).toBe(
      "healthy",
    );

    // A still-unhealthy endpoint stays quarantined and its clock restarts.
    servers.get("https://b")!.healthy = true; // sanity: b never failed
  });

  it("keeps a still-failing endpoint quarantined and restarts its clock", async () => {
    let now = 0;
    const { balancer, servers } = makeBalancer(
      [{ url: "https://a" }, { url: "https://b" }],
      { now: () => now, quarantineDurationMs: 60_000 },
    );
    servers.get("https://a")!.healthy = false;

    balancer.recordResult("https://a", { success: false, latencyMs: 10 });
    balancer.recordResult("https://a", { success: false, latencyMs: 10 });
    balancer.recordResult("https://a", { success: false, latencyMs: 10 });

    now += 60_001;
    await balancer.runHealthChecks();
    expect(balancer.getEndpointStates().find((e) => e.url === "https://a")!.status).toBe(
      "quarantined",
    );

    // Fix it and let the (restarted) quarantine clock elapse again.
    servers.get("https://a")!.healthy = true;
    now += 60_001;
    await balancer.runHealthChecks();
    expect(balancer.getEndpointStates().find((e) => e.url === "https://a")!.status).toBe(
      "healthy",
    );
  });

  it("falls back to the highest-scored endpoint when all are demoted", () => {
    const { balancer } = makeBalancer([{ url: "https://a" }, { url: "https://b" }]);

    // "a" gets one fast success before its 3 errors -> better latency/error
    // profile than "b", which only ever errors. Both still end up demoted.
    balancer.recordResult("https://a", { success: true, latencyMs: 1 });
    balancer.recordResult("https://a", { success: false, latencyMs: 10 });
    balancer.recordResult("https://a", { success: false, latencyMs: 10 });
    balancer.recordResult("https://a", { success: false, latencyMs: 10 });

    balancer.recordResult("https://b", { success: false, latencyMs: 10 });
    balancer.recordResult("https://b", { success: false, latencyMs: 10 });
    balancer.recordResult("https://b", { success: false, latencyMs: 10 });

    const states = balancer.getEndpointStates();
    expect(states.every((e) => e.status === "quarantined")).toBe(true);

    const scoreA = states.find((e) => e.url === "https://a")!.score;
    const scoreB = states.find((e) => e.url === "https://b")!.score;
    expect(scoreA).toBeGreaterThan(scoreB);

    // Falls back to the higher-scored ("a") endpoint instead of throwing.
    expect(balancer.selectEndpoint().url).toBe("https://a");
  });

  it("execute() records success/failure automatically", async () => {
    const { balancer } = makeBalancer([{ url: "https://a" }]);
    await balancer.execute(async () => "ok");
    const state = balancer.getEndpointStates()[0]!;
    expect(state.errorRate).toBe(0);

    await expect(
      balancer.execute(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(balancer.getEndpointStates()[0]!.errorRate).toBeGreaterThan(0);
  });

  it("rejects construction with an empty endpoint list", () => {
    expect(() => new RpcLoadBalancer([])).toThrow();
  });
});
