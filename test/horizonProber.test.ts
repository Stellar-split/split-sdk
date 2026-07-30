/**
 * Unit tests for #546 — HorizonProber
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { HorizonProber } from "../src/horizonProber.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRootResponse(latestLedger: number) {
  return { history_latest_ledger: latestLedger } as unknown;
}

describe("HorizonProber", () => {
  const ENDPOINT = "https://horizon-testnet.stellar.org";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // probe() — basic reachability
  // -------------------------------------------------------------------------

  it("returns reachable=true and correct latestLedger on success", async () => {
    const prober = new HorizonProber({ horizonUrl: ENDPOINT });

    const mockServer = {
      fetchRoot: vi.fn().mockResolvedValue(makeRootResponse(1234)),
    };

    // Inject mock server
    vi.spyOn(prober as unknown as { _withTimeout: () => Promise<unknown> }, "_withTimeout")
      .mockResolvedValue(makeRootResponse(1234));

    // Instead: patch the internal server by constructing the prober and then
    // mocking probe's internals via _withTimeout being swapped out
    const patcher = prober as unknown as {
      _withTimeout: (p: Promise<unknown>, ms: number) => Promise<unknown>;
    };
    patcher._withTimeout = (_promise: Promise<unknown>, _ms: number) =>
      Promise.resolve(makeRootResponse(1234));

    const result = await prober.probe(ENDPOINT);

    expect(result.reachable).toBe(true);
    expect(result.latestLedger).toBe(1234);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it("returns reachable=false when the request fails", async () => {
    const prober = new HorizonProber({ horizonUrl: ENDPOINT });

    const patcher = prober as unknown as {
      _withTimeout: (p: Promise<unknown>, ms: number) => Promise<unknown>;
    };
    patcher._withTimeout = () => Promise.reject(new Error("connection refused"));

    const result = await prober.probe(ENDPOINT);

    expect(result.reachable).toBe(false);
    expect(result.latestLedger).toBe(0);
    expect(result.error).toContain("connection refused");
  });

  // -------------------------------------------------------------------------
  // Staleness detection
  // -------------------------------------------------------------------------

  it("sets isStale=false when the ledger is advancing", async () => {
    const prober = new HorizonProber({
      horizonUrl: ENDPOINT,
      stalenessThresholdMs: 5_000,
    });

    const patcher = prober as unknown as {
      _withTimeout: (p: Promise<unknown>, ms: number) => Promise<unknown>;
    };
    patcher._withTimeout = () => Promise.resolve(makeRootResponse(100));

    const r1 = await prober.probe(ENDPOINT);
    expect(r1.isStale).toBe(false);

    // New ledger — should still not be stale
    patcher._withTimeout = () => Promise.resolve(makeRootResponse(101));
    const r2 = await prober.probe(ENDPOINT);
    expect(r2.isStale).toBe(false);
  });

  it("sets isStale=true when ledger does not advance past stalenessThresholdMs", async () => {
    const now = Date.now();
    let fakeNow = now;

    const prober = new HorizonProber({
      horizonUrl: ENDPOINT,
      stalenessThresholdMs: 1_000,
    });

    const patcher = prober as unknown as {
      _withTimeout: (p: Promise<unknown>, ms: number) => Promise<unknown>;
      _checkStaleness: (ledger: number, nowMs: number) => boolean;
    };

    // Prime the internal state: first call sees ledger 200
    patcher._withTimeout = () => Promise.resolve(makeRootResponse(200));
    await prober.probe(ENDPOINT);

    // Second call: still ledger 200, but 2 seconds have elapsed → stale
    patcher._withTimeout = () => Promise.resolve(makeRootResponse(200));

    // Manipulate the internal lastLedgerSeenAt to simulate time passing
    const internal = prober as unknown as { lastLedgerSeenAt: number };
    internal.lastLedgerSeenAt = now - 2_000; // 2s ago

    const result = await prober.probe(ENDPOINT);
    expect(result.isStale).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Degradation and recovery events
  // -------------------------------------------------------------------------

  it("emits horizonEndpointDegraded after 2 consecutive failures", async () => {
    const onDegraded = vi.fn();
    const prober = new HorizonProber({
      horizonUrl: ENDPOINT,
      onDegraded,
      degradedAfterConsecutiveFailures: 2,
    });

    const patcher = prober as unknown as {
      _withTimeout: (p: Promise<unknown>, ms: number) => Promise<unknown>;
    };
    patcher._withTimeout = () => Promise.reject(new Error("timeout"));

    await prober.probe(ENDPOINT);
    expect(onDegraded).not.toHaveBeenCalled();

    await prober.probe(ENDPOINT);
    expect(onDegraded).toHaveBeenCalledOnce();
    expect(onDegraded.mock.calls[0][0].reachable).toBe(false);
  });

  it("emits horizonEndpointRecovered on first successful probe after degraded", async () => {
    const onDegraded = vi.fn();
    const onRecovered = vi.fn();
    const prober = new HorizonProber({
      horizonUrl: ENDPOINT,
      onDegraded,
      onRecovered,
      degradedAfterConsecutiveFailures: 1,
    });

    const patcher = prober as unknown as {
      _withTimeout: (p: Promise<unknown>, ms: number) => Promise<unknown>;
    };

    // First probe: fail → degraded
    patcher._withTimeout = () => Promise.reject(new Error("fail"));
    await prober.probe(ENDPOINT);
    expect(onDegraded).toHaveBeenCalledOnce();
    expect(onRecovered).not.toHaveBeenCalled();

    // Second probe: success → recovered
    patcher._withTimeout = () => Promise.resolve(makeRootResponse(500));
    await prober.probe(ENDPOINT);
    expect(onRecovered).toHaveBeenCalledOnce();
    expect(onRecovered.mock.calls[0][0].reachable).toBe(true);
  });

  it("does NOT emit recovered when still degraded", async () => {
    const onRecovered = vi.fn();
    const prober = new HorizonProber({
      horizonUrl: ENDPOINT,
      onRecovered,
      degradedAfterConsecutiveFailures: 2,
    });

    const patcher = prober as unknown as {
      _withTimeout: (p: Promise<unknown>, ms: number) => Promise<unknown>;
    };
    patcher._withTimeout = () => Promise.reject(new Error("fail"));

    await prober.probe(ENDPOINT);
    await prober.probe(ENDPOINT);
    await prober.probe(ENDPOINT);

    expect(onRecovered).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // getLastResult / isDegraded
  // -------------------------------------------------------------------------

  it("returns null from getLastResult before any probe", () => {
    const prober = new HorizonProber({ horizonUrl: ENDPOINT });
    expect(prober.getLastResult()).toBeNull();
  });

  it("getLastResult returns the most recent result after a probe", async () => {
    const prober = new HorizonProber({ horizonUrl: ENDPOINT });

    const patcher = prober as unknown as {
      _withTimeout: (p: Promise<unknown>, ms: number) => Promise<unknown>;
    };
    patcher._withTimeout = () => Promise.resolve(makeRootResponse(999));

    await prober.probe(ENDPOINT);
    const last = prober.getLastResult();

    expect(last).not.toBeNull();
    expect(last!.latestLedger).toBe(999);
  });

  it("isDegraded reflects current degradation state", async () => {
    const prober = new HorizonProber({
      horizonUrl: ENDPOINT,
      degradedAfterConsecutiveFailures: 1,
    });

    expect(prober.isDegraded()).toBe(false);

    const patcher = prober as unknown as {
      _withTimeout: (p: Promise<unknown>, ms: number) => Promise<unknown>;
    };
    patcher._withTimeout = () => Promise.reject(new Error("fail"));

    await prober.probe(ENDPOINT);
    expect(prober.isDegraded()).toBe(true);

    patcher._withTimeout = () => Promise.resolve(makeRootResponse(100));
    await prober.probe(ENDPOINT);
    expect(prober.isDegraded()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // healthDashboard integration
  // -------------------------------------------------------------------------

  it("health dashboard includes prober last result when registered", async () => {
    const { registerHorizonProber, getSDKHealth, resetSDKHealth } = await import(
      "../src/healthDashboard.js"
    );

    resetSDKHealth();

    const prober = new HorizonProber({ horizonUrl: ENDPOINT });
    const patcher = prober as unknown as {
      _withTimeout: (p: Promise<unknown>, ms: number) => Promise<unknown>;
    };
    patcher._withTimeout = () => Promise.resolve(makeRootResponse(777));
    await prober.probe(ENDPOINT);

    registerHorizonProber(prober);

    const health = await getSDKHealth();
    expect(health.horizonProbe).not.toBeNull();
    expect(health.horizonProbe!.latestLedger).toBe(777);
  });
});
