import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TokenRefreshManager,
  TokenRefreshError,
  decodeTokenExpiry,
  type TokenRefreshConfig,
} from "../src/tokenRefresh.js";

function makeJwt(expSeconds: number): string {
  const header = btoa(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = btoa(JSON.stringify({ sub: "user", exp: expSeconds }));
  return `${header}.${payload}.signature`;
}

function okResponse(token: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ token }),
  } as unknown as Response;
}

function failedResponse(status: number) {
  return { ok: false, status, json: async () => ({}) } as unknown as Response;
}

describe("TokenRefreshManager", () => {
  const nowSeconds = 1_700_000_000;
  let manager: TokenRefreshManager | undefined;

  const make = (overrides: Partial<TokenRefreshConfig> = {}) => {
    manager = new TokenRefreshManager({
      refreshEndpoint: "https://example.com/auth/refresh",
      now: () => Date.now(),
      jitter: false,
      retryBaseDelayMs: 0,
      ...overrides,
    });
    return manager;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(nowSeconds * 1000);
  });

  afterEach(() => {
    manager?.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("decodeTokenExpiry", () => {
    it("decodes exp and rejects malformed tokens", () => {
      expect(decodeTokenExpiry(makeJwt(nowSeconds + 120))).toBe((nowSeconds + 120) * 1000);
      expect(decodeTokenExpiry("not-a-jwt")).toBeNull();
      expect(decodeTokenExpiry("a.b.c")).toBeNull();
    });
  });

  it("refreshes preemptively when the cached token is near expiry", async () => {
    const next = makeJwt(nowSeconds + 3600);
    const fetchMock = vi.fn().mockResolvedValue(okResponse(next));
    const instance = make({ fetch: fetchMock as unknown as typeof fetch });
    instance.setToken(makeJwt(nowSeconds + 30));

    expect(await instance.getToken()).toBe(next);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(instance.stats().successes).toBe(1);
    expect(instance.refreshedEvents()[0]?.attempt).toBe(1);
  });

  it("schedules a refresh before expiry without an explicit getToken call", async () => {
    const next = makeJwt(nowSeconds + 7200);
    const fetchMock = vi.fn().mockResolvedValue(okResponse(next));
    const instance = make({ fetch: fetchMock as unknown as typeof fetch });
    instance.setToken(makeJwt(nowSeconds + 120));

    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(instance.peekToken()).toBe(next);
  });

  it("retries transient failures and tracks each failed attempt", async () => {
    const next = makeJwt(nowSeconds + 3600);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(failedResponse(503))
      .mockResolvedValueOnce(failedResponse(500))
      .mockResolvedValueOnce(okResponse(next));
    const instance = make({ fetch: fetchMock as unknown as typeof fetch });
    const failures: number[] = [];
    instance.onRefreshFailed((event) => failures.push(event.attempt));
    instance.setToken(makeJwt(nowSeconds + 10));

    expect(await instance.getToken()).toBe(next);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(failures).toEqual([1, 2]);
    expect(instance.stats()).toMatchObject({ failures: 2, successes: 1 });
  });

  it("falls back when every refresh attempt fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(failedResponse(500));
    const instance = make({
      fetch: fetchMock as unknown as typeof fetch,
      maxRetries: 2,
      fallbackToken: "fallback-token",
    });
    instance.setToken(makeJwt(nowSeconds + 10));

    expect(await instance.getToken()).toBe("fallback-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(instance.stats()).toMatchObject({ fallbacks: 1, failures: 2 });
  });

  it("throws a typed error when refresh fails and no fallback is configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(failedResponse(401));
    const instance = make({
      fetch: fetchMock as unknown as typeof fetch,
      maxRetries: 1,
    });
    instance.setToken(makeJwt(nowSeconds + 10));

    await expect(instance.getToken()).rejects.toBeInstanceOf(TokenRefreshError);
  });

  it("coalesces concurrent callers into a single refresh cycle", async () => {
    const next = makeJwt(nowSeconds + 3600);
    let resolveFetch: (value: Response) => void = () => undefined;
    const fetchMock = vi.fn(
      () => new Promise<Response>((resolve) => { resolveFetch = resolve; }),
    );
    const instance = make({ fetch: fetchMock as unknown as typeof fetch });
    instance.setToken(makeJwt(nowSeconds + 10));

    const first = instance.getToken();
    const second = instance.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(instance.isRefreshing).toBe(true);

    resolveFetch(okResponse(next));
    expect(await Promise.all([first, second])).toEqual([next, next]);
    expect(instance.stats().queued).toBe(1);
  });

  it("keeps tracking bounded and free of token values", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(makeJwt(nowSeconds + 3600)));
    const instance = make({
      fetch: fetchMock as unknown as typeof fetch,
      maxTrackedEvents: 2,
    });

    for (let i = 0; i < 4; i += 1) {
      await instance.refresh();
    }

    expect(instance.refreshedEvents()).toHaveLength(2);
    expect(JSON.stringify(instance.refreshedEvents())).not.toContain("signature");
    expect(JSON.stringify(instance.failedEvents())).not.toContain("signature");
  });

  it("releases queued callers on dispose", async () => {
    let resolveFetch: (value: Response) => void = () => undefined;
    const fetchMock = vi.fn(
      () => new Promise<Response>((resolve) => { resolveFetch = resolve; }),
    );
    const instance = make({ fetch: fetchMock as unknown as typeof fetch });
    instance.setToken(makeJwt(nowSeconds + 10));
    const pending = instance.getToken();

    instance.dispose();
    await expect(pending).rejects.toBeInstanceOf(TokenRefreshError);
    resolveFetch(okResponse(makeJwt(nowSeconds + 3600)));
  });
});
