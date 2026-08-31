import { rpc as SorobanRpc } from "@stellar/stellar-sdk";

export class WarmStandby {
  private readonly servers: SorobanRpc.Server[];
  private currentIndex = 0;
  private healthCheckHandle: ReturnType<typeof setInterval> | null = null;
  private recoveryHandle: ReturnType<typeof setInterval> | null = null;

  constructor(urls: string[]) {
    this.servers = urls.map(
      (url) => new SorobanRpc.Server(url, { allowHttp: url.startsWith("http://") })
    );
  }

  get server(): SorobanRpc.Server {
    return this.servers[this.currentIndex]!;
  }

  failover(): void {
    if (this.servers.length > 1) {
      this.currentIndex = (this.currentIndex + 1) % this.servers.length;
    }
  }

  start(): void {
    // Keep secondary connections warm with periodic health pings
    this.healthCheckHandle = setInterval(() => {
      const secondaryIdx = this.currentIndex === 0 ? 1 : 0;
      if (secondaryIdx < this.servers.length) {
        void this.servers[secondaryIdx]!.getHealth().catch(() => undefined);
      }
    }, 30_000);

    // Check if primary has recovered and switch back
    this.recoveryHandle = setInterval(() => {
      if (this.currentIndex === 0) return;
      void this.servers[0]!.getHealth()
        .then(() => { this.currentIndex = 0; })
        .catch(() => undefined);
    }, 60_000);
  }

  stop(): void {
    if (this.healthCheckHandle !== null) {
      clearInterval(this.healthCheckHandle);
      this.healthCheckHandle = null;
    }
    if (this.recoveryHandle !== null) {
      clearInterval(this.recoveryHandle);
      this.recoveryHandle = null;
    }
  }
}

// ---------------------------------------------------------------------------
// StandbyController — issue #702
// ---------------------------------------------------------------------------

/** Options accepted by {@link StandbyController}. */
export interface StandbyControllerOptions {
  /**
   * Duration in milliseconds during which standby activation is suppressed
   * after {@link StandbyController.start} is called.
   *
   * Useful to prevent normal initialisation traffic from falsely triggering
   * standby mode during startup.
   *
   * @default 0
   */
  warmUpMs?: number;

  /**
   * Milliseconds of inactivity before standby mode is activated.
   *
   * @default 30_000
   */
  inactivityMs?: number;
}

/**
 * Controls standby-mode activation based on inactivity, with an optional
 * warm-up window that suppresses standby during startup.
 *
 * @example
 * ```typescript
 * const ctrl = new StandbyController({ warmUpMs: 5_000, inactivityMs: 30_000 });
 * ctrl.onStandby(() => console.log("entered standby"));
 * ctrl.start();
 *
 * // Record activity whenever the SDK makes an RPC call:
 * ctrl.recordActivity();
 * ```
 */
export class StandbyController {
  private readonly warmUpMs: number;
  private readonly inactivityMs: number;
  private standbyListeners: Array<() => void> = [];
  private inactivityHandle: ReturnType<typeof setTimeout> | null = null;
  private warmUpHandle: ReturnType<typeof setTimeout> | null = null;
  private isWarmedUp = false;
  private isStandby = false;
  private started = false;

  constructor(options: StandbyControllerOptions = {}) {
    this.warmUpMs = options.warmUpMs ?? 0;
    this.inactivityMs = options.inactivityMs ?? 30_000;
  }

  /**
   * Register a callback invoked when standby mode activates.
   */
  onStandby(listener: () => void): void {
    this.standbyListeners.push(listener);
  }

  /**
   * Start the controller.  The warm-up timer begins immediately; inactivity
   * detection only arms once the warm-up period has elapsed.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.isStandby = false;

    if (this.warmUpMs > 0) {
      // Suppress inactivity detection during the warm-up window.
      this.warmUpHandle = setTimeout(() => {
        this.warmUpHandle = null;
        this.isWarmedUp = true;
        this.scheduleStandby();
      }, this.warmUpMs);
    } else {
      this.isWarmedUp = true;
      this.scheduleStandby();
    }
  }

  /**
   * Record that activity occurred.  Resets the inactivity timer (but only
   * after the warm-up period has ended).
   */
  recordActivity(): void {
    if (!this.isWarmedUp) return;
    this.cancelStandby();
    this.scheduleStandby();
  }

  /** Whether the controller is currently in standby mode. */
  get standby(): boolean {
    return this.isStandby;
  }

  /** Stop the controller and cancel all pending timers. */
  stop(): void {
    this.cancelStandby();
    if (this.warmUpHandle !== null) {
      clearTimeout(this.warmUpHandle);
      this.warmUpHandle = null;
    }
    this.started = false;
    this.isWarmedUp = false;
    this.isStandby = false;
  }

  // ---- private helpers ----

  private scheduleStandby(): void {
    this.inactivityHandle = setTimeout(() => {
      this.inactivityHandle = null;
      this.isStandby = true;
      for (const listener of this.standbyListeners) {
        listener();
      }
    }, this.inactivityMs);
  }

  private cancelStandby(): void {
    if (this.inactivityHandle !== null) {
      clearTimeout(this.inactivityHandle);
      this.inactivityHandle = null;
    }
    this.isStandby = false;
  }
}
