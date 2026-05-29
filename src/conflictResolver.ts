import type { Invoice, ConflictStrategy } from "./types.js";

export function resolveConflict(
  local: Invoice,
  remote: Invoice,
  strategy: ConflictStrategy
): Invoice {
  switch (strategy) {
    case "remote-wins":
      return remote;
    case "local-wins":
      return local;
    case "latest-ledger": {
      const localLedger = local.lastModifiedLedger ?? 0;
      const remoteLedger = remote.lastModifiedLedger ?? 0;
      return remoteLedger >= localLedger ? remote : local;
    }
  }
}
