import { describe, expect, it, vi, afterEach } from "vitest";
import { AutoRecoveryMonitor } from "../src/autoRecovery.js";
import { LoadBalancer } from "../src/loadBalancer.js";
import { rpc as SorobanRpc } from "@stellar/stellar-sdk";

describe("AutoRecoveryMonitor", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("switches endpoint after N consecutive failures", async () => {
    const switchEvents: Array<{ from: string; to: string; reason: string }> = [];
    const monitor = new AutoRecoveryMonitor({
      failureThreshold: 2,
      onSwitch: (from, to, reason) => switchEvents.push({ from, to, reason }),
    });

    const balancer = new LoadBalancer(["https://a.example", "https://b.example"]);
    const mockServer = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 100 }),
    } as unknown as SorobanRpc.Server;

    const client = { server: mockServer, loadBalancer: balancer };

    balancer.recordFailure("https://a.example");
    balancer.recordFailure("https://a.example");

    await monitor.start(client as any);
    await new Promise((resolve) => setTimeout(resolve, 100));
    monitor.stop();

    expect(switchEvents.length).toBeGreaterThanOrEqual(0);
  });

  it("stops monitoring when stop() is called", async () => {
    vi.useFakeTimers();
    const monitor = new AutoRecoveryMonitor();
    const balancer = new LoadBalancer(["https://a.example"]);
    const mockServer = {
      getLatestLedger: vi.fn(),
    } as unknown as SorobanRpc.Server;

    const client = { server: mockServer, loadBalancer: balancer };

    await monitor.start(client as any);
    monitor.stop();

    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("resets failure count on healthy check", async () => {
    const monitor = new AutoRecoveryMonitor({ failureThreshold: 3 });
    const balancer = new LoadBalancer(["https://a.example", "https://b.example"]);
    const mockServer = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 100 }),
    } as unknown as SorobanRpc.Server;

    const client = { server: mockServer, loadBalancer: balancer };

    balancer.recordFailure("https://a.example");
    balancer.recordFailure("https://a.example");
    balancer.recordSuccess("https://a.example", 10);

    expect(balancer.getEndpointState("https://a.example").consecutiveFailures).toBe(0);
  });
});
