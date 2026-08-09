import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

// TokenRefreshInterceptor implementation
interface TokenRefreshInterceptorConfig {
  challengeEndpoint: string;
  tokenEndpoint: string;
  refreshBufferMs?: number;
}

interface TokenRefreshEvent {
  timestamp: number;
  newToken: string;
}

interface TokenRefreshFailedError extends Error {
  name: "TokenRefreshFailedError";
  originalError: Error;
}

class TokenRefreshInterceptor {
  private refreshBufferMs: number;
  private currentToken: string | null = null;
  private tokenExpiry: number | null = null;
  private refreshScheduleId: NodeJS.Timeout | null = null;
  private requestQueue: Array<{ resolve: Function; reject: Function }> = [];
  private isRefreshing = false;
  private onTokenRefreshedHandlers: Array<(event: TokenRefreshEvent) => void> = [];
  private onRefreshFailedHandlers: Array<(error: TokenRefreshFailedError) => void> = [];
  private challengeEndpoint: string;
  private tokenEndpoint: string;
  private walletAdapter: { sign: (tx: string) => Promise<string> };

  constructor(
    config: TokenRefreshInterceptorConfig,
    walletAdapter: { sign: (tx: string) => Promise<string> }
  ) {
    this.challengeEndpoint = config.challengeEndpoint;
    this.tokenEndpoint = config.tokenEndpoint;
    this.refreshBufferMs = config.refreshBufferMs ?? 60_000;
    this.walletAdapter = walletAdapter;
  }

  setToken(token: string): void {
    this.currentToken = token;
    this.parseAndScheduleRefresh(token);
  }

  private parseAndScheduleRefresh(token: string): void {
    const parts = token.split(".");
    if (parts.length !== 3) return;

    try {
      const payload = JSON.parse(Buffer.from(parts[1], "base64").toString());
      if (payload.exp) {
        this.tokenExpiry = payload.exp * 1000;
        this.scheduleRefresh();
      }
    } catch {
      // Ignore parse errors
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshScheduleId) clearTimeout(this.refreshScheduleId);

    if (!this.tokenExpiry) return;

    const now = Date.now();
    const refreshAt = this.tokenExpiry - this.refreshBufferMs;
    const delay = Math.max(0, refreshAt - now);

    this.refreshScheduleId = setTimeout(() => {
      this.performRefresh().catch((err) => {
        this.onRefreshFailedHandlers.forEach((h) => h(err));
      });
    }, delay);
  }

  private async performRefresh(): Promise<void> {
    if (this.isRefreshing) return;
    this.isRefreshing = true;

    try {
      const challengeResponse = await fetch(this.challengeEndpoint);
      const { challengeXdr } = await challengeResponse.json();

      const signedXdr = await this.walletAdapter.sign(challengeXdr);

      const tokenResponse = await fetch(this.tokenEndpoint, {
        method: "POST",
        body: JSON.stringify({ signedXdr }),
      });
      const { token: newToken } = await tokenResponse.json();

      this.currentToken = newToken;
      this.parseAndScheduleRefresh(newToken);

      const event: TokenRefreshEvent = {
        timestamp: Date.now(),
        newToken,
      };
      this.onTokenRefreshedHandlers.forEach((h) => h(event));

      const queue = this.requestQueue;
      this.requestQueue = [];
      queue.forEach((q) => q.resolve(newToken));
    } catch (error) {
      const refreshError: TokenRefreshFailedError = {
        name: "TokenRefreshFailedError",
        message: `Token refresh failed: ${error}`,
        originalError: error as Error,
      };
      this.requestQueue.forEach((q) => q.reject(refreshError));
      this.requestQueue = [];
      throw refreshError;
    } finally {
      this.isRefreshing = false;
    }
  }

  async getToken(): Promise<string> {
    if (!this.currentToken) {
      throw new Error("No token available");
    }

    const isExpiredOrNearExpiry =
      this.tokenExpiry && this.tokenExpiry - Date.now() < this.refreshBufferMs;

    if (isExpiredOrNearExpiry && !this.isRefreshing) {
      return this.performRefresh().then(() => this.currentToken!);
    }

    if (this.isRefreshing) {
      return new Promise((resolve, reject) => {
        this.requestQueue.push({ resolve, reject });
      });
    }

    return this.currentToken;
  }

  onTokenRefreshed(handler: (event: TokenRefreshEvent) => void): void {
    this.onTokenRefreshedHandlers.push(handler);
  }

  onRefreshFailed(handler: (error: TokenRefreshFailedError) => void): void {
    this.onRefreshFailedHandlers.push(handler);
  }

  dispose(): void {
    if (this.refreshScheduleId) clearTimeout(this.refreshScheduleId);
  }
}

describe("TokenRefreshInterceptor", () => {
  let interceptor: TokenRefreshInterceptor;
  let walletAdapter: { sign: (tx: string) => Promise<string> };
  const now = Math.floor(Date.now() / 1000);

  beforeEach(() => {
    vi.useFakeTimers();
    walletAdapter = {
      sign: vi.fn().mockResolvedValue("signed-xdr"),
    };
  });

  afterEach(() => {
    if (interceptor) interceptor.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("detects an expiring token and triggers preemptive refresh", async () => {
    const expiryTime = now + 180; // 3 minutes from now
    const token = createJWT({ exp: expiryTime });

    global.fetch = vi.fn((url: string) => {
      if (url.includes("challenge")) {
        return Promise.resolve(
          new Response(JSON.stringify({ challengeXdr: "challenge-tx" }))
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ token: createJWT({ exp: now + 7200 }) }))
      );
    });

    interceptor = new TokenRefreshInterceptor(
      {
        challengeEndpoint: "https://example.com/challenge",
        tokenEndpoint: "https://example.com/token",
        refreshBufferMs: 60_000,
      },
      walletAdapter
    );

    interceptor.setToken(token);

    const refreshedHandler = vi.fn();
    interceptor.onTokenRefreshed(refreshedHandler);

    // Advance exactly to the scheduled refresh time (expiry - buffer = 120s)
    await vi.advanceTimersByTimeAsync(120_000);

    expect(walletAdapter.sign).toHaveBeenCalled();
    expect(refreshedHandler).toHaveBeenCalled();
  });

  it("queues 5 concurrent in-flight requests during refresh and replays them with new token", async () => {
    const expiryTime = now + 180;
    const token = createJWT({ exp: expiryTime });
    const newToken = createJWT({ exp: now + 7200 });

    global.fetch = vi.fn((url: string) => {
      if (url.includes("challenge")) {
        return new Promise((res) => {
          setTimeout(
            () => res(new Response(JSON.stringify({ challengeXdr: "challenge-tx" }))),
            100
          );
        });
      }
      return new Promise((res) => {
        setTimeout(
          () => res(new Response(JSON.stringify({ token: newToken }))),
          100
        );
      });
    });

    interceptor = new TokenRefreshInterceptor(
      {
        challengeEndpoint: "https://example.com/challenge",
        tokenEndpoint: "https://example.com/token",
        refreshBufferMs: 60_000,
      },
      walletAdapter
    );

    interceptor.setToken(token);

    // Advance to trigger the refresh timer — performRefresh starts, isRefreshing = true
    vi.advanceTimersByTime(120_000);

    // Queue 5 concurrent requests while refresh is in progress (isRefreshing = true)
    const requests = Array.from({ length: 5 }, () => interceptor.getToken());

    // Advance past both 100ms fetch delays to complete the refresh
    await vi.advanceTimersByTimeAsync(250);

    const results = await Promise.all(requests);

    expect(results).toHaveLength(5);
    expect(results.every((r) => r === newToken)).toBe(true);
  });

  it("rejects queued requests with TokenRefreshFailedError on failed refresh", async () => {
    const expiryTime = now + 180;
    const token = createJWT({ exp: expiryTime });

    global.fetch = vi.fn(() => {
      return Promise.reject(new Error("Network error"));
    });

    interceptor = new TokenRefreshInterceptor(
      {
        challengeEndpoint: "https://example.com/challenge",
        tokenEndpoint: "https://example.com/token",
        refreshBufferMs: 60_000,
      },
      walletAdapter
    );

    interceptor.setToken(token);

    const failedHandler = vi.fn();
    interceptor.onRefreshFailed(failedHandler);

    // Trigger the refresh timer — performRefresh starts, isRefreshing = true
    vi.advanceTimersByTime(120_000);

    // Queue a request while refresh is in progress; catch immediately to avoid unhandled rejection
    const request = interceptor.getToken().catch((e: unknown) => e);

    // Flush microtasks to let the rejected fetch propagate through performRefresh
    await vi.runAllTimersAsync();

    const error = await request;
    expect(error).toMatchObject({ name: "TokenRefreshFailedError" });
    expect(failedHandler).toHaveBeenCalled();
  });

  it("uses wallet adapter to sign SEP-10 challenge transaction", async () => {
    const expiryTime = now + 180;
    const token = createJWT({ exp: expiryTime });

    global.fetch = vi.fn((url: string) => {
      if (url.includes("challenge")) {
        return Promise.resolve(
          new Response(JSON.stringify({ challengeXdr: "challenge-tx-xdr" }))
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ token: createJWT({ exp: now + 7200 }) }))
      );
    });

    interceptor = new TokenRefreshInterceptor(
      {
        challengeEndpoint: "https://example.com/challenge",
        tokenEndpoint: "https://example.com/token",
        refreshBufferMs: 60_000,
      },
      walletAdapter
    );

    interceptor.setToken(token);

    // Advance exactly to the scheduled refresh time (expiry - buffer = 120s)
    await vi.advanceTimersByTimeAsync(120_000);

    expect(walletAdapter.sign).toHaveBeenCalledWith("challenge-tx-xdr");
  });
});

function createJWT(payload: Record<string, any>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64");
  return `${header}.${body}.signature`;
}
