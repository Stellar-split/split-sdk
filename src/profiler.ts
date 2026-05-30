import { StellarSplitClient } from "./client.js";

export interface ProfileEntry {
  method: string;
  durationMs: number;
  timestamp: number;
}

export interface ProfileSession {
  startedAt: number;
  stoppedAt: number;
  entries: ProfileEntry[];
}

export interface ProfileReport {
  sessions: ProfileSession[];
}

export class ProfilerSession {
  private sessions: ProfileSession[] = [];
  private active = false;
  private currentEntries: ProfileEntry[] = [];
  private currentStartedAt = 0;
  private currentStoppedAt = 0;
  private originalMethods = new Map<string, Function>();

  start(): void {
    if (this.active) {
      return;
    }

    const clientPrototype = StellarSplitClient.prototype as unknown as Record<string, unknown>;
    const methodNames = Object.getOwnPropertyNames(clientPrototype).filter(
      (key) => key !== "constructor" && typeof clientPrototype[key] === "function"
    );

    const thisSession = this;
    for (const methodName of methodNames) {
      const original = clientPrototype[methodName] as Function;
      this.originalMethods.set(methodName, original);

      clientPrototype[methodName] = function (this: unknown, ...args: unknown[]) {
        const startTime = performance.now();
        const record = (): void => {
          const durationMs = performance.now() - startTime;
          thisSession.currentEntries.push({
            method: methodName,
            durationMs,
            timestamp: Date.now(),
          });
        };

        const result = original.apply(this, args);

        if (result && typeof (result as Promise<unknown>).then === "function") {
          return (result as Promise<unknown>).finally(record);
        }

        record();
        return result;
      } as unknown as Function;
    }

    this.currentEntries = [];
    this.currentStartedAt = Date.now();
    this.active = true;
  }

  stop(): ProfileReport {
    if (!this.active) {
      return { sessions: [...this.sessions] };
    }

    const clientPrototype = StellarSplitClient.prototype as unknown as Record<string, unknown>;
    for (const [methodName, original] of this.originalMethods.entries()) {
      clientPrototype[methodName] = original;
    }

    this.currentStoppedAt = Date.now();
    this.sessions.push({
      startedAt: this.currentStartedAt,
      stoppedAt: this.currentStoppedAt,
      entries: [...this.currentEntries],
    });

    this.active = false;
    this.originalMethods.clear();

    return this.getReport();
  }

  getReport(): ProfileReport {
    return { sessions: [...this.sessions] };
  }
}
