import { FinalityTimeoutError } from "./errors.js";
import { emitSdkEvent } from "./events.js";
import type { FinalityCheckConfig, FinalityStatus } from "./types.js";

interface CallBuilder<T> {
  call(): Promise<T>;
}

interface TransactionRecordLike {
  ledger: number | string;
  successful?: boolean;
  result_successful?: boolean;
}

interface LedgerRecordLike {
  sequence?: number | string;
}

export interface FinalityServerLike {
  transactions(): {
    transaction(hash: string): CallBuilder<TransactionRecordLike>;
  };
  ledgers(): {
    order(direction: "desc"): {
      limit(limit: number): CallBuilder<{ records: LedgerRecordLike[] }>;
    };
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class FinalityChecker {
  private readonly server: FinalityServerLike;
  private readonly config: Required<FinalityCheckConfig>;

  constructor(server: FinalityServerLike, config: FinalityCheckConfig = {}) {
    this.server = server;
    this.config = {
      minConfirmations: config.minConfirmations ?? 2,
      pollIntervalMs: config.pollIntervalMs ?? 1_000,
      maxWaitMs: config.maxWaitMs ?? 30_000,
    };
  }

  async check(txHash: string): Promise<FinalityStatus> {
    const startedAt = Date.now();

    while (true) {
      const status = await this.readStatus(txHash);
      if (status.finalized) {
        emitSdkEvent("invoiceFinalized", { txHash, finality: status });
        return status;
      }

      if (Date.now() - startedAt >= this.config.maxWaitMs) {
        throw new FinalityTimeoutError(txHash, this.config.maxWaitMs);
      }

      await sleep(this.config.pollIntervalMs);
    }
  }

  private async readStatus(txHash: string): Promise<FinalityStatus> {
    const tx = await this.server.transactions().transaction(txHash).call();
    const ledgerSequence = Number(tx.ledger);
    const latest = await this.server.ledgers().order("desc").limit(1).call();
    const currentLedger = Number(latest.records[0]?.sequence ?? ledgerSequence);
    const confirmations = Math.max(0, currentLedger - ledgerSequence);
    const successful = tx.successful === true || tx.result_successful === true;

    return {
      finalized: successful && confirmations >= this.config.minConfirmations,
      confirmations,
      ledgerSequence,
    };
  }
}
