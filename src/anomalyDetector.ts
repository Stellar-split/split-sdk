import { EventEmitter } from "events";
import { createRequire } from "module";
import { getLatestBlockTimestamp } from "./blockchainClient.js";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

interface AnomalyDetectorOptions {
  rapidCycleSeconds?: number;
  maxAmountVariance?: number;
  sensitivityThreshold?: number;
  now?: () => number;
}

export class AnomalyDetector {
  private latestBlockTime: number | null = null;
  private previousTxCount: number = 0;
  private previousTotalAmount: number = 0;
  private rapidCycleCount: number = 0;
  private rapidCycleStart: number = 0;
  private lastDetectionLog: number = 0;
  private readonly detectionCooldownMs: number = 1_000;
  private readonly rapidCycleSeconds: number;
  private readonly maxAmountVariance: number;
  private readonly sensitivityThreshold: number;
  private readonly now: () => number;
  private readonly emitter: EventEmitter;

  constructor(options: AnomalyDetectorOptions = {}) {
    this.emitter = new EventEmitter();
    this.rapidCycleSeconds = options.rapidCycleSeconds ?? 300;
    this.maxAmountVariance = options.maxAmountVariance ?? 0.8;
    this.sensitivityThreshold = options.sensitivityThreshold ?? 0.8;
    if (
      !Number.isFinite(this.sensitivityThreshold) ||
      this.sensitivityThreshold <= 0 ||
      this.sensitivityThreshold > 1
    ) {
      throw new RangeError("sensitivityThreshold must be in the range (0, 1]");
    }
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async processTransaction(
    txHash: string,
    amount: number,
    recipient: string
  ): Promise<{
    anomalyDetected: boolean;
    signal: string | null;
    timestamp: number;
  }> {
    const currentTime = this.now();
    const blockTimestamp = await getLatestBlockTimestamp();
    if (blockTimestamp !== null) {
      this.latestBlockTime = blockTimestamp;
    }

    const txCountIncrease = 1;
    const amountIncrease = amount;
    const timeSinceLastTx = currentTime - (this.lastDetectionLog || currentTime);

    let anomalyDetected = false;
    let signal: string | null = null;

    // Check for rapid cycle (more than 10 transactions in rapidCycleSeconds)
    if (currentTime - this.rapidCycleStart < this.rapidCycleSeconds) {
      this.rapidCycleCount++;
      if (this.rapidCycleCount > 10) {
        anomalyDetected = true;
        signal = "RAPID_CYCLE_DETECTED";
      }
    } else {
      this.rapidCycleCount = 1;
      this.rapidCycleStart = currentTime;
    }

    // Check for sudden spike in transaction count
    if (!anomalyDetected && this.previousTxCount > 0) {
      const txCountChange =
        this.previousTxCount > 0
          ? (txCountIncrease / this.previousTxCount) * 100
          : 0;
      if (txCountChange > this.sensitivityThreshold * 100) {
        anomalyDetected = true;
        signal = "TX_COUNT_SPIKE";
      }
    }

    // Check for sudden spike in total transaction amount
    if (!anomalyDetected && this.previousTotalAmount > 0) {
      const amountChange =
        this.previousTotalAmount > 0
          ? (amountIncrease / this.previousTotalAmount) * 100
          : 0;
      if (amountChange > this.sensitivityThreshold * 100) {
        anomalyDetected = true;
        signal = "AMOUNT_SPIKE";
      }
    }

    // Check for unusually large transactions
    if (!anomalyDetected && amount > this.maxAmountVariance * 1e18) {
      anomalyDetected = true;
      signal = "LARGE_TRANSACTION";
    }

    // Update state
    this.previousTxCount += txCountIncrease;
    this.previousTotalAmount += amountIncrease;
    this.lastDetectionLog = currentTime;

    if (anomalyDetected) {
      console.log(
        `[Stellar-Split v${version}] Anomaly detected: ${signal} | Hash: ${txHash} | Recipient: ${recipient} | Time: ${new Date(currentTime * 1000).toISOString()}`
      );
      this.emitter.emit("anomaly", {
        txHash,
        signal,
        timestamp: currentTime,
        blockTimestamp: this.latestBlockTime,
      });
    }

    return { anomalyDetected, signal, timestamp: currentTime };
  }

  onAnomaly(callback: (data: {
    txHash: string;
    signal: string | null;
    timestamp: number;
    blockTimestamp: number | null;
  }) => void): void {
    this.emitter.on("anomaly", callback);
  }

  reset(): void {
    this.previousTxCount = 0;
    this.previousTotalAmount = 0;
    this.rapidCycleCount = 0;
    this.rapidCycleStart = this.now();
    this.lastDetectionLog = 0;
  }
}
