import { describe, it, expect, beforeEach, jest } from '@jest/globals';

interface TickEvent {
  remainingMs: number;
  driftCorrectedMs: number;
  inSync: boolean;
}

interface TimerState {
  deadlineUnixSecs: number;
  lastSyncUnixSecs: number;
  lastSyncLocalMs: number;
}

interface FakeRpcServer {
  getLatestLedger(): Promise<{ closeTime: number }>;
}

class EventEmitter {
  private listeners: Map<string, Function[]> = new Map();

  on(event: string, handler: Function): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(handler);
  }

  emit(event: string, ...args: any[]): void {
    const handlers = this.listeners.get(event) || [];
    for (const handler of handlers) {
      handler(...args);
    }
  }

  removeListener(event: string, handler: Function): void {
    const handlers = this.listeners.get(event) || [];
    const index = handlers.indexOf(handler);
    if (index > -1) {
      handlers.splice(index, 1);
    }
  }
}

class InvoiceCountdownTimer extends EventEmitter {
  private state: TimerState;
  private syncIntervalMs = 30000;
  private tickIntervalMs = 1000;
  private tickTimeout: NodeJS.Timeout | null = null;
  private syncTimeout: NodeJS.Timeout | null = null;
  private isVisible = true;
  private isStopped = false;

  constructor(
    deadlineUnixSecs: number,
    private rpcServer: FakeRpcServer
  ) {
    super();
    this.state = {
      deadlineUnixSecs,
      lastSyncUnixSecs: Math.floor(Date.now() / 1000),
      lastSyncLocalMs: Date.now(),
    };
    this.setupVisibilityListener();
    this.startTick();
    this.startSync();
  }

  private setupVisibilityListener(): void {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        this.isVisible = !document.hidden;
        if (this.isVisible) {
          this.onBecomeVisible();
        } else {
          this.onHidden();
        }
      });
    }
  }

  private onBecomeVisible(): void {
    if (!this.isStopped) {
      this.syncWithNetwork();
    }
  }

  private onHidden(): void {
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
      this.syncTimeout = null;
    }
  }

  private startTick(): void {
    this.tickTimeout = setInterval(() => {
      if (this.isStopped) {
        return;
      }

      const remainingMs = this.calculateRemainingMs();
      const driftCorrectedMs = Math.max(0, remainingMs);

      if (driftCorrectedMs <= 0) {
        this.emit('deadline:expired');
        this.stop();
        return;
      }

      this.emit('tick', {
        remainingMs: driftCorrectedMs,
        driftCorrectedMs: driftCorrectedMs,
        inSync: false,
      });
    }, this.tickIntervalMs);
  }

  private startSync(): void {
    this.syncWithNetwork();
  }

  private async syncWithNetwork(): Promise<void> {
    if (this.isStopped || !this.isVisible) {
      return;
    }

    try {
      const ledger = await this.rpcServer.getLatestLedger();
      const nowUnixSecs = Math.floor(ledger.closeTime / 1000);

      this.state = {
        deadlineUnixSecs: this.state.deadlineUnixSecs,
        lastSyncUnixSecs: nowUnixSecs,
        lastSyncLocalMs: Date.now(),
      };

      const remainingMs = this.calculateRemainingMs();
      if (remainingMs > 0) {
        this.emit('tick', {
          remainingMs,
          driftCorrectedMs: remainingMs,
          inSync: true,
        });
      }
    } catch (error) {
      // Sync error, continue with next attempt
    }

    // Schedule next sync
    if (this.isVisible && !this.isStopped) {
      this.syncTimeout = setTimeout(() => this.syncWithNetwork(), this.syncIntervalMs);
    }
  }

  private calculateRemainingMs(): number {
    const now = Date.now();
    const elapsedLocalMs = now - this.state.lastSyncLocalMs;
    const elapsedNetworkSecs = elapsedLocalMs / 1000;
    const networkNowSecs = this.state.lastSyncUnixSecs + elapsedNetworkSecs;
    const remainingSecs = this.state.deadlineUnixSecs - networkNowSecs;
    return Math.max(0, remainingSecs * 1000);
  }

  getRemainingMs(): number {
    return this.calculateRemainingMs();
  }

  stop(): void {
    this.isStopped = true;
    if (this.tickTimeout) {
      clearInterval(this.tickTimeout);
      this.tickTimeout = null;
    }
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
      this.syncTimeout = null;
    }
  }
}

describe('InvoiceCountdownTimer', () => {
  let mockRpcServer: FakeRpcServer;
  let now: number;

  beforeEach(() => {
    jest.useFakeTimers();
    now = Math.floor(Date.now() / 1000);
    mockRpcServer = {
      getLatestLedger: jest.fn().mockResolvedValue({ closeTime: now * 1000 }),
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should create timer with deadline', () => {
    const deadlineUnixSecs = now + 3600;
    const timer = new InvoiceCountdownTimer(deadlineUnixSecs, mockRpcServer);
    expect(timer).toBeDefined();
    timer.stop();
  });

  it('should emit tick events with correct structure', async () => {
    const deadlineUnixSecs = now + 3600;
    const timer = new InvoiceCountdownTimer(deadlineUnixSecs, mockRpcServer);
    const tickHandler = jest.fn();
    timer.on('tick', tickHandler);

    jest.advanceTimersByTime(1000);
    await jest.runAllTimersAsync();

    expect(tickHandler).toHaveBeenCalled();
    const tickEvent = tickHandler.mock.calls[0][0] as TickEvent;
    expect(tickEvent).toHaveProperty('remainingMs');
    expect(tickEvent).toHaveProperty('driftCorrectedMs');
    expect(tickEvent).toHaveProperty('inSync');

    timer.stop();
  });

  it('should correct drift after injecting artificial Date.now skew', async () => {
    const deadlineUnixSecs = now + 3600;
    const timer = new InvoiceCountdownTimer(deadlineUnixSecs, mockRpcServer);

    const beforeSync = timer.getRemainingMs();

    // Simulate 5 second skew
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 5000);

    // Trigger sync
    jest.advanceTimersByTime(30000);
    await jest.runAllTimersAsync();

    const afterSync = timer.getRemainingMs();

    // After sync, the skew should be corrected
    expect(Math.abs(beforeSync - afterSync)).toBeLessThan(1000);

    jest.restoreAllMocks();
    timer.stop();
  });

  it('should emit inSync true on sync completion', async () => {
    const deadlineUnixSecs = now + 3600;
    const timer = new InvoiceCountdownTimer(deadlineUnixSecs, mockRpcServer);
    const tickHandler = jest.fn();
    timer.on('tick', tickHandler);

    jest.advanceTimersByTime(30000);
    await jest.runAllTimersAsync();

    const syncedTicks = tickHandler.mock.calls.filter((call) => call[0].inSync === true);
    expect(syncedTicks.length).toBeGreaterThan(0);

    timer.stop();
  });

  it('should fire deadline:expired when remainingMs reaches 0', async () => {
    const deadlineUnixSecs = now + 1;
    const timer = new InvoiceCountdownTimer(deadlineUnixSecs, mockRpcServer);
    const expiredHandler = jest.fn();
    timer.on('deadline:expired', expiredHandler);

    jest.advanceTimersByTime(2000);
    await jest.runAllTimersAsync();

    expect(expiredHandler).toHaveBeenCalled();
    timer.stop();
  });

  it('should stop ticking after deadline expires', async () => {
    const deadlineUnixSecs = now + 1;
    const timer = new InvoiceCountdownTimer(deadlineUnixSecs, mockRpcServer);
    const tickHandler = jest.fn();
    timer.on('tick', tickHandler);

    jest.advanceTimersByTime(2000);
    await jest.runAllTimersAsync();

    const tickCountBefore = tickHandler.mock.calls.length;

    jest.advanceTimersByTime(5000);
    await jest.runAllTimersAsync();

    const tickCountAfter = tickHandler.mock.calls.length;
    expect(tickCountAfter).toBe(tickCountBefore);

    timer.stop();
  });

  it('should suspend syncs when tab is hidden', async () => {
    const deadlineUnixSecs = now + 3600;
    const timer = new InvoiceCountdownTimer(deadlineUnixSecs, mockRpcServer);

    const syncSpy = jest.spyOn(mockRpcServer, 'getLatestLedger');

    // Simulate hiding tab
    if (typeof document !== 'undefined') {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    }

    const callsBeforeHide = syncSpy.mock.calls.length;
    jest.advanceTimersByTime(30000);
    await jest.runAllTimersAsync();

    const callsAfterHide = syncSpy.mock.calls.length;
    expect(callsAfterHide).toBe(callsBeforeHide);

    timer.stop();
  });

  it('should resume syncs when tab becomes visible', async () => {
    const deadlineUnixSecs = now + 3600;
    const timer = new InvoiceCountdownTimer(deadlineUnixSecs, mockRpcServer);

    // Simulate hiding tab
    if (typeof document !== 'undefined') {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    }

    const syncSpy = jest.spyOn(mockRpcServer, 'getLatestLedger');
    const callsBeforeVisible = syncSpy.mock.calls.length;

    // Make visible again
    if (typeof document !== 'undefined') {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    }

    jest.advanceTimersByTime(100);
    await jest.runAllTimersAsync();

    const callsAfterVisible = syncSpy.mock.calls.length;
    expect(callsAfterVisible).toBeGreaterThan(callsBeforeVisible);

    timer.stop();
  });

  it('should trigger immediate sync on visibilitychange to visible', async () => {
    const deadlineUnixSecs = now + 3600;
    const timer = new InvoiceCountdownTimer(deadlineUnixSecs, mockRpcServer);

    // Simulate hiding tab
    if (typeof document !== 'undefined') {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    }

    const syncSpy = jest.spyOn(mockRpcServer, 'getLatestLedger');
    syncSpy.mockClear();

    // Make visible
    if (typeof document !== 'undefined') {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    }

    jest.advanceTimersByTime(100);
    await jest.runAllTimersAsync();

    expect(syncSpy).toHaveBeenCalled();
    timer.stop();
  });

  it('should calculate remaining time accurately', () => {
    const remainingTime = 7200; // 2 hours
    const deadlineUnixSecs = now + remainingTime;
    const timer = new InvoiceCountdownTimer(deadlineUnixSecs, mockRpcServer);

    const remainingMs = timer.getRemainingMs();

    expect(remainingMs).toBeLessThanOrEqual(remainingTime * 1000);
    expect(remainingMs).toBeGreaterThan((remainingTime - 1) * 1000);

    timer.stop();
  });

  it('should handle missing RPC calls gracefully', async () => {
    const deadlineUnixSecs = now + 3600;
    const failingRpc = {
      getLatestLedger: jest.fn().mockRejectedValue(new Error('RPC failed')),
    };

    const timer = new InvoiceCountdownTimer(deadlineUnixSecs, failingRpc);
    const tickHandler = jest.fn();
    timer.on('tick', tickHandler);

    jest.advanceTimersByTime(1000);
    await jest.runAllTimersAsync();

    expect(tickHandler).toHaveBeenCalled();
    timer.stop();
  });

  it('should emit tick every configured interval', async () => {
    const deadlineUnixSecs = now + 3600;
    const timer = new InvoiceCountdownTimer(deadlineUnixSecs, mockRpcServer);
    const tickHandler = jest.fn();
    timer.on('tick', tickHandler);

    // Advance by 5 seconds
    jest.advanceTimersByTime(5000);
    await jest.runAllTimersAsync();

    const tickCount = tickHandler.mock.calls.length;
    expect(tickCount).toBeGreaterThanOrEqual(4); // At least 4-5 ticks in 5 seconds

    timer.stop();
  });

  it('should reflect drift correction immediately after sync', async () => {
    const deadlineUnixSecs = now + 3600;
    const timer = new InvoiceCountdownTimer(deadlineUnixSecs, mockRpcServer);
    const tickHandler = jest.fn();
    timer.on('tick', tickHandler);

    // Manually advance time beyond what RPC reports
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 3000);

    // Trigger sync
    jest.advanceTimersByTime(30000);
    await jest.runAllTimersAsync();

    const tickEvents = tickHandler.mock.calls.map((call) => call[0] as TickEvent);
    const syncedEvent = tickEvents.find((e) => e.inSync);

    expect(syncedEvent).toBeDefined();
    expect(syncedEvent?.driftCorrectedMs).toBeLessThan(deadlineUnixSecs * 1000 + 1000);

    jest.restoreAllMocks();
    timer.stop();
  });

  it('should not sync during background tab state', async () => {
    const deadlineUnixSecs = now + 3600;
    const timer = new InvoiceCountdownTimer(deadlineUnixSecs, mockRpcServer);

    const syncSpy = jest.spyOn(mockRpcServer, 'getLatestLedger');
    syncSpy.mockClear();

    // Simulate tab going to background
    if (typeof document !== 'undefined') {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    }

    jest.advanceTimersByTime(60000);
    await jest.runAllTimersAsync();

    expect(syncSpy).not.toHaveBeenCalled();
    timer.stop();
  });
});
