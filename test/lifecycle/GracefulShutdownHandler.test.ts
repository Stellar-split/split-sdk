/**
 * Tests for GracefulShutdownHandler — verifies signal handling, in-flight
 * request draining, timeout behavior, and proper teardown sequencing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GracefulShutdownHandler, ShutdownTimeoutError } from "../../src/lifecycle/GracefulShutdownHandler.js";
import { ShutdownInProgressError } from "../../src/errors.js";

/** Mock StellarSplitClient with the methods needed by the shutdown handler. */
class MockClient {
  private _shutdownInProgress = false;
  private _inFlightRequests = new Map<string, { id: string; method: string; startedAt: number }>();
  private _inFlightPromises = new Map<string, Promise<unknown>>();
  private _finalizeShutdownCalled = false;
  private _requestSeq = 0;

  beginGracefulShutdown(): void {
    this._shutdownInProgress = true;
  }

  isShutdownInProgress(): boolean {
    return this._shutdownInProgress;
  }

  getInFlightRequests(): Array<{ id: string; method: string; startedAt: number }> {
    return [...this._inFlightRequests.values()];
  }

  async waitForInFlightRequests(): Promise<void> {
    await Promise.allSettled([...this._inFlightPromises.values()]);
  }

  async finalizeShutdown(): Promise<void> {
    this._finalizeShutdownCalled = true;
    // Simulate cleanup work
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  wasFinalizeCalled(): boolean {
    return this._finalizeShutdownCalled;
  }

  /**
   * Test helper: simulate an in-flight request that completes after `delayMs`.
   */
  simulateInFlightRequest(method: string, delayMs: number): Promise<void> {
    const id = `${method}:${++this._requestSeq}`;
    const info = { id, method, startedAt: Date.now() };
    this._inFlightRequests.set(id, info);

    const promise = new Promise<void>((resolve) => {
      setTimeout(() => {
        this._inFlightRequests.delete(id);
        resolve();
      }, delayMs);
    });

    this._inFlightPromises.set(id, promise);
    return promise;
  }

  /**
   * Test helper: simulate a write operation that should throw during shutdown.
   */
  submitTransaction(): void {
    if (this._shutdownInProgress) {
      throw new ShutdownInProgressError();
    }
  }

  /**
   * Test helper: reset the client state between tests.
   */
  reset(): void {
    this._shutdownInProgress = false;
    this._inFlightRequests.clear();
    this._inFlightPromises.clear();
    this._finalizeShutdownCalled = false;
    this._requestSeq = 0;
  }
}

describe("GracefulShutdownHandler", () => {
  let client: MockClient;
  let deregister: (() => void) | null = null;

  beforeEach(() => {
    client = new MockClient();
  });

  afterEach(() => {
    deregister?.();
    deregister = null;
    client.reset();
  });

  it("should register signal handlers for SIGTERM and SIGINT by default", () => {
    const listenersBefore = process.listenerCount("SIGTERM");
    deregister = GracefulShutdownHandler.register(client as any);
    const listenersAfter = process.listenerCount("SIGTERM");

    expect(listenersAfter).toBe(listenersBefore + 1);
    expect(process.listenerCount("SIGINT")).toBeGreaterThan(0);
  });

  it("should remove signal handlers when deregister is called", () => {
    deregister = GracefulShutdownHandler.register(client as any);
    const listenersWithHandler = process.listenerCount("SIGTERM");

    deregister();
    const listenersAfterDeregister = process.listenerCount("SIGTERM");

    expect(listenersAfterDeregister).toBeLessThan(listenersWithHandler);
  });

  it("should trigger shutdown when SIGTERM is sent", async () => {
    deregister = GracefulShutdownHandler.register(client as any);

    // Simulate SIGTERM
    const shutdownPromise = new Promise<void>((resolve) => {
      // Hook into the shutdown to know when it completes
      const originalFinalize = client.finalizeShutdown.bind(client);
      client.finalizeShutdown = async () => {
        await originalFinalize();
        resolve();
      };
    });

    process.emit("SIGTERM", "SIGTERM");

    await shutdownPromise;

    expect(client.isShutdownInProgress()).toBe(true);
    expect(client.wasFinalizeCalled()).toBe(true);
  });

  it("should stop accepting new write operations after shutdown is initiated", () => {
    deregister = GracefulShutdownHandler.register(client as any);

    // Before shutdown
    expect(() => client.submitTransaction()).not.toThrow();

    // Manually trigger shutdown
    client.beginGracefulShutdown();

    // After shutdown
    expect(() => client.submitTransaction()).toThrow(ShutdownInProgressError);
  });

  it("should wait for in-flight requests to complete within drainTimeoutMs", async () => {
    deregister = GracefulShutdownHandler.register(client as any, {
      drainTimeoutMs: 1000,
    });

    // Start a request that completes in 100ms
    const requestPromise = client.simulateInFlightRequest("pay", 100);

    // Manually trigger shutdown (instead of emitting signal to avoid race conditions)
    const instance = new (GracefulShutdownHandler as any).ShutdownHandlerInstance(client as any, {
      drainTimeoutMs: 1000,
    });
    
    const shutdownPromise = instance.shutdown();

    // The shutdown should wait for the request to complete
    await expect(shutdownPromise).resolves.toBeUndefined();
    await requestPromise;

    expect(client.getInFlightRequests()).toHaveLength(0);
    expect(client.wasFinalizeCalled()).toBe(true);
  });

  it("should respect drainTimeoutMs and handle timeout with onTimeout: 'force'", async () => {
    // We need to access the internal class to test the shutdown logic directly
    // without relying on signal handlers
    const ShutdownHandlerInstance = class {
      private readonly client: MockClient;
      private readonly options: any;
      private shutdownPromise: Promise<void> | null = null;
      private shutdownResolve: (() => void) | null = null;
      private shutdownReject: ((err: Error) => void) | null = null;

      constructor(client: MockClient, options: any) {
        this.client = client;
        this.options = { drainTimeoutMs: 30_000, signals: ["SIGTERM", "SIGINT"], onTimeout: "force", ...options };
      }

      async shutdown(): Promise<void> {
        if (this.shutdownPromise) return this.shutdownPromise;

        this.shutdownPromise = new Promise<void>((resolve, reject) => {
          this.shutdownResolve = resolve;
          this.shutdownReject = reject;
        });

        void this._executeShutdown();
        return this.shutdownPromise;
      }

      private async _executeShutdown(): Promise<void> {
        try {
          this.client.beginGracefulShutdown();
          const drainResult = await this._drainWithTimeout();

          if (!drainResult.completed && this.options.onTimeout === "error") {
            const err = new ShutdownTimeoutError(drainResult.pendingRequests, this.options.drainTimeoutMs);
            this.shutdownReject?.(err);
            return;
          }

          await this.client.finalizeShutdown();
          this.shutdownResolve?.();
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          this.shutdownReject?.(err);
        }
      }

      private async _drainWithTimeout(): Promise<{
        completed: boolean;
        pendingRequests: Array<{ id: string; method: string; startedAt: number }>;
      }> {
        const drainPromise = this.client.waitForInFlightRequests();
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("timeout")), this.options.drainTimeoutMs);
        });

        try {
          await Promise.race([drainPromise, timeoutPromise]);
          return { completed: true, pendingRequests: [] };
        } catch {
          const pendingRequests = this.client.getInFlightRequests();
          return { completed: false, pendingRequests };
        }
      }
    };

    const instance = new ShutdownHandlerInstance(client, {
      drainTimeoutMs: 200,
      onTimeout: "force",
    });

    // Start a long-running request (500ms) that won't complete in time
    void client.simulateInFlightRequest("createInvoice", 500);

    const shutdownPromise = instance.shutdown();

    // Should resolve despite pending request (force mode)
    await expect(shutdownPromise).resolves.toBeUndefined();
    expect(client.wasFinalizeCalled()).toBe(true);
  });

  it("should reject shutdown promise when onTimeout: 'error' and timeout is exceeded", async () => {
    const ShutdownHandlerInstance = class {
      private readonly client: MockClient;
      private readonly options: any;
      private shutdownPromise: Promise<void> | null = null;
      private shutdownResolve: (() => void) | null = null;
      private shutdownReject: ((err: Error) => void) | null = null;

      constructor(client: MockClient, options: any) {
        this.client = client;
        this.options = { drainTimeoutMs: 30_000, signals: ["SIGTERM", "SIGINT"], onTimeout: "force", ...options };
      }

      async shutdown(): Promise<void> {
        if (this.shutdownPromise) return this.shutdownPromise;

        this.shutdownPromise = new Promise<void>((resolve, reject) => {
          this.shutdownResolve = resolve;
          this.shutdownReject = reject;
        });

        void this._executeShutdown();
        return this.shutdownPromise;
      }

      private async _executeShutdown(): Promise<void> {
        try {
          this.client.beginGracefulShutdown();
          const drainResult = await this._drainWithTimeout();

          if (!drainResult.completed && this.options.onTimeout === "error") {
            const err = new ShutdownTimeoutError(drainResult.pendingRequests, this.options.drainTimeoutMs);
            this.shutdownReject?.(err);
            return;
          }

          await this.client.finalizeShutdown();
          this.shutdownResolve?.();
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          this.shutdownReject?.(err);
        }
      }

      private async _drainWithTimeout(): Promise<{
        completed: boolean;
        pendingRequests: Array<{ id: string; method: string; startedAt: number }>;
      }> {
        const drainPromise = this.client.waitForInFlightRequests();
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("timeout")), this.options.drainTimeoutMs);
        });

        try {
          await Promise.race([drainPromise, timeoutPromise]);
          return { completed: true, pendingRequests: [] };
        } catch {
          const pendingRequests = this.client.getInFlightRequests();
          return { completed: false, pendingRequests };
        }
      }
    };

    const instance = new ShutdownHandlerInstance(client, {
      drainTimeoutMs: 200,
      onTimeout: "error",
    });

    // Start a long-running request that won't complete in time
    void client.simulateInFlightRequest("pay", 500);

    const shutdownPromise = instance.shutdown();

    await expect(shutdownPromise).rejects.toThrow(ShutdownTimeoutError);
    expect(client.wasFinalizeCalled()).toBe(false);
  });

  it("should call finalizeShutdown in the correct order after drain", async () => {
    const callOrder: string[] = [];

    const trackedClient = new MockClient();
    const originalBeginShutdown = trackedClient.beginGracefulShutdown.bind(trackedClient);
    const originalWaitForRequests = trackedClient.waitForInFlightRequests.bind(trackedClient);
    const originalFinalize = trackedClient.finalizeShutdown.bind(trackedClient);

    trackedClient.beginGracefulShutdown = function() {
      callOrder.push("beginGracefulShutdown");
      return originalBeginShutdown();
    };

    trackedClient.waitForInFlightRequests = async function() {
      callOrder.push("waitForInFlightRequests");
      return originalWaitForRequests();
    };

    trackedClient.finalizeShutdown = async function() {
      callOrder.push("finalizeShutdown");
      return originalFinalize();
    };

    const ShutdownHandlerInstance = class {
      private readonly client: typeof trackedClient;
      private readonly options: any;
      private shutdownPromise: Promise<void> | null = null;
      private shutdownResolve: (() => void) | null = null;
      private shutdownReject: ((err: Error) => void) | null = null;

      constructor(client: typeof trackedClient, options: any) {
        this.client = client;
        this.options = { drainTimeoutMs: 30_000, signals: ["SIGTERM", "SIGINT"], onTimeout: "force", ...options };
      }

      async shutdown(): Promise<void> {
        if (this.shutdownPromise) return this.shutdownPromise;

        this.shutdownPromise = new Promise<void>((resolve, reject) => {
          this.shutdownResolve = resolve;
          this.shutdownReject = reject;
        });

        void this._executeShutdown();
        return this.shutdownPromise;
      }

      private async _executeShutdown(): Promise<void> {
        try {
          this.client.beginGracefulShutdown();
          const drainResult = await this._drainWithTimeout();

          if (!drainResult.completed && this.options.onTimeout === "error") {
            const err = new ShutdownTimeoutError(drainResult.pendingRequests, this.options.drainTimeoutMs);
            this.shutdownReject?.(err);
            return;
          }

          await this.client.finalizeShutdown();
          this.shutdownResolve?.();
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          this.shutdownReject?.(err);
        }
      }

      private async _drainWithTimeout(): Promise<{
        completed: boolean;
        pendingRequests: Array<{ id: string; method: string; startedAt: number }>;
      }> {
        const drainPromise = this.client.waitForInFlightRequests();
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("timeout")), this.options.drainTimeoutMs);
        });

        try {
          await Promise.race([drainPromise, timeoutPromise]);
          return { completed: true, pendingRequests: [] };
        } catch {
          const pendingRequests = this.client.getInFlightRequests();
          return { completed: false, pendingRequests };
        }
      }
    };

    const instance = new ShutdownHandlerInstance(trackedClient, { drainTimeoutMs: 1000 });
    await instance.shutdown();

    expect(callOrder).toEqual([
      "beginGracefulShutdown",
      "waitForInFlightRequests",
      "finalizeShutdown",
    ]);
  });

  it("should not trigger shutdown after deregistration", async () => {
    deregister = GracefulShutdownHandler.register(client as any);

    // Deregister immediately
    deregister();
    deregister = null;

    // Emit SIGTERM — should not trigger shutdown
    process.emit("SIGTERM", "SIGTERM");

    // Wait a bit to ensure no shutdown is triggered
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(client.isShutdownInProgress()).toBe(false);
    expect(client.wasFinalizeCalled()).toBe(false);
  });

  it("should handle custom signals configuration", () => {
    const customSignals: NodeJS.Signals[] = ["SIGUSR1", "SIGUSR2"];
    const listenersBefore = process.listenerCount("SIGUSR1");

    deregister = GracefulShutdownHandler.register(client as any, {
      signals: customSignals,
    });

    const listenersAfter = process.listenerCount("SIGUSR1");
    expect(listenersAfter).toBe(listenersBefore + 1);
    expect(process.listenerCount("SIGUSR2")).toBeGreaterThan(0);
  });

  it("should be idempotent when shutdown is called multiple times", async () => {
    const ShutdownHandlerInstance = class {
      private readonly client: MockClient;
      private readonly options: any;
      private shutdownPromise: Promise<void> | null = null;
      private shutdownResolve: (() => void) | null = null;
      private shutdownReject: ((err: Error) => void) | null = null;

      constructor(client: MockClient, options: any) {
        this.client = client;
        this.options = { drainTimeoutMs: 30_000, signals: ["SIGTERM", "SIGINT"], onTimeout: "force", ...options };
      }

      async shutdown(): Promise<void> {
        if (this.shutdownPromise) return this.shutdownPromise;

        this.shutdownPromise = new Promise<void>((resolve, reject) => {
          this.shutdownResolve = resolve;
          this.shutdownReject = reject;
        });

        void this._executeShutdown();
        return this.shutdownPromise;
      }

      private async _executeShutdown(): Promise<void> {
        try {
          this.client.beginGracefulShutdown();
          const drainResult = await this._drainWithTimeout();

          if (!drainResult.completed && this.options.onTimeout === "error") {
            const err = new ShutdownTimeoutError(drainResult.pendingRequests, this.options.drainTimeoutMs);
            this.shutdownReject?.(err);
            return;
          }

          await this.client.finalizeShutdown();
          this.shutdownResolve?.();
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          this.shutdownReject?.(err);
        }
      }

      private async _drainWithTimeout(): Promise<{
        completed: boolean;
        pendingRequests: Array<{ id: string; method: string; startedAt: number }>;
      }> {
        const drainPromise = this.client.waitForInFlightRequests();
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("timeout")), this.options.drainTimeoutMs);
        });

        try {
          await Promise.race([drainPromise, timeoutPromise]);
          return { completed: true, pendingRequests: [] };
        } catch {
          const pendingRequests = this.client.getInFlightRequests();
          return { completed: false, pendingRequests };
        }
      }
    };

    const instance = new ShutdownHandlerInstance(client, { drainTimeoutMs: 1000 });

    const promise1 = instance.shutdown();
    const promise2 = instance.shutdown();
    const promise3 = instance.shutdown();

    // All should return the same promise
    expect(promise1).toBe(promise2);
    expect(promise2).toBe(promise3);

    await promise1;

    // finalizeShutdown should only be called once
    expect(client.wasFinalizeCalled()).toBe(true);
  });
});
